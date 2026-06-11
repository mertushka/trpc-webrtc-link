import {
  WebRTCChannelClosedError,
  WebRTCChannelNotOpenError,
  WebRTCQueueOverflowError,
  WebRTCUnreliableChannelError,
} from './errors.js';
import { getUTF8ByteLength, serializeWebRTCFrame, type WebRTCProtocolFrame } from './protocol.js';

export type RTCDataChannelReadyState = 'connecting' | 'open' | 'closing' | 'closed';

export interface RTCDataChannelEventLike {
  readonly type?: string;
}

export interface RTCDataChannelMessageEventLike extends RTCDataChannelEventLike {
  readonly data: unknown;
}

export type RTCDataChannelEventListener = (event: any) => void;

export interface RTCDataChannelLike {
  readonly readyState: RTCDataChannelReadyState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readonly ordered?: boolean;
  readonly maxPacketLifeTime?: number | null;
  readonly maxRetransmits?: number | null;
  addEventListener(type: string, listener: RTCDataChannelEventListener): void;
  removeEventListener(type: string, listener: RTCDataChannelEventListener): void;
  send(data: string): void;
  close(): void;
}

export interface WebRTCBackpressureOptions {
  /**
   * Pause outbound writes after `bufferedAmount` rises above this value.
   * @default 1048576
   */
  highWatermark?: number;
  /**
   * Resume outbound writes after `bufferedAmount` falls to this value.
   * @default 262144
   */
  lowWatermark?: number;
  /**
   * Maximum number of frames waiting to be sent.
   * @default 1024
   */
  queueLimit?: number;
  /**
   * Maximum encoded size of one JSON frame.
   * @default 1048576
   */
  maxMessageBytes?: number;
}

interface NormalizedBackpressureOptions {
  highWatermark: number;
  lowWatermark: number;
  queueLimit: number;
  maxMessageBytes: number;
}

interface QueuedWrite {
  payload: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

const DEFAULT_BACKPRESSURE_OPTIONS: NormalizedBackpressureOptions = {
  highWatermark: 1024 * 1024,
  lowWatermark: 256 * 1024,
  queueLimit: 1024,
  maxMessageBytes: 1024 * 1024,
};

export function normalizeBackpressureOptions(
  options: WebRTCBackpressureOptions | undefined,
): NormalizedBackpressureOptions {
  const normalized = {
    ...DEFAULT_BACKPRESSURE_OPTIONS,
    ...options,
  };
  if (!Number.isFinite(normalized.highWatermark) || normalized.highWatermark < 0) {
    throw new RangeError('highWatermark must be a finite non-negative number');
  }
  if (!Number.isFinite(normalized.lowWatermark) || normalized.lowWatermark < 0) {
    throw new RangeError('lowWatermark must be a finite non-negative number');
  }
  if (normalized.lowWatermark > normalized.highWatermark) {
    throw new RangeError('lowWatermark must not exceed highWatermark');
  }
  if (!Number.isSafeInteger(normalized.queueLimit) || normalized.queueLimit < 1) {
    throw new RangeError('queueLimit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(normalized.maxMessageBytes) || normalized.maxMessageBytes < 1) {
    throw new RangeError('maxMessageBytes must be a positive safe integer');
  }
  return normalized;
}

export function assertReliableOrderedChannel(channel: RTCDataChannelLike): void {
  if (channel.ordered === false) {
    throw new WebRTCUnreliableChannelError('trpc-webrtc/1 requires an ordered RTCDataChannel');
  }
  if (channel.maxPacketLifeTime != null || channel.maxRetransmits != null) {
    throw new WebRTCUnreliableChannelError(
      'trpc-webrtc/1 requires a reliable RTCDataChannel without retransmit limits',
    );
  }
}

export async function waitForDataChannelOpen(
  channel: RTCDataChannelLike,
  timeoutMs: number,
): Promise<void> {
  if (channel.readyState === 'open') {
    return;
  }
  if (channel.readyState === 'closing' || channel.readyState === 'closed') {
    throw new WebRTCChannelClosedError();
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new WebRTCChannelClosedError());
    };
    const onError = (cause: unknown) => {
      cleanup();
      reject(
        new WebRTCChannelNotOpenError('RTCDataChannel failed before opening', {
          cause,
        }),
      );
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new WebRTCChannelNotOpenError(`RTCDataChannel did not open within ${timeoutMs}ms`));
    }, timeoutMs);

    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onError);
  });
}

export class DataChannelWriter {
  readonly #channel: RTCDataChannelLike;
  readonly #options: NormalizedBackpressureOptions;
  readonly #queues = new Map<string, QueuedWrite[]>();
  readonly #keyOrder: string[] = [];
  readonly #previousLowThreshold: number;
  #queuedCount = 0;
  #pumping = false;
  #closedError: Error | null = null;

  readonly #onBufferedAmountLow = () => {
    this.#schedulePump();
  };

  readonly #onClose = () => {
    this.close(new WebRTCChannelClosedError());
  };

  readonly #onError = (cause: unknown) => {
    this.close(new WebRTCChannelClosedError('RTCDataChannel emitted an error', { cause }));
  };

  public constructor(channel: RTCDataChannelLike, options?: WebRTCBackpressureOptions) {
    this.#channel = channel;
    this.#options = normalizeBackpressureOptions(options);
    this.#previousLowThreshold = channel.bufferedAmountLowThreshold;
    channel.bufferedAmountLowThreshold = this.#options.lowWatermark;
    channel.addEventListener('bufferedamountlow', this.#onBufferedAmountLow);
    channel.addEventListener('close', this.#onClose);
    channel.addEventListener('error', this.#onError);
  }

  public get maxMessageBytes(): number {
    return this.#options.maxMessageBytes;
  }

  public send(frame: WebRTCProtocolFrame, queueKey = 'control'): Promise<void> {
    if (this.#closedError) {
      return Promise.reject(this.#closedError);
    }

    let payload: string;
    try {
      payload = serializeWebRTCFrame(frame);
    } catch (cause) {
      return Promise.reject(
        new TypeError('WebRTC frame is not JSON serializable', {
          cause,
        }),
      );
    }
    if (getUTF8ByteLength(payload) > this.#options.maxMessageBytes) {
      return Promise.reject(
        new RangeError(`WebRTC frame exceeds the ${this.#options.maxMessageBytes} byte limit`),
      );
    }
    if (this.#queuedCount >= this.#options.queueLimit) {
      return Promise.reject(new WebRTCQueueOverflowError(this.#options.queueLimit));
    }

    return new Promise<void>((resolve, reject) => {
      const queue = this.#queues.get(queueKey);
      const write = { payload, resolve, reject };
      if (queue) {
        queue.push(write);
      } else {
        this.#queues.set(queueKey, [write]);
        this.#keyOrder.push(queueKey);
      }
      this.#queuedCount += 1;
      this.#schedulePump();
    });
  }

  public cancelKey(queueKey: string, error: Error): boolean {
    const queue = this.#queues.get(queueKey);
    if (!queue) {
      return false;
    }
    this.#queues.delete(queueKey);
    const index = this.#keyOrder.indexOf(queueKey);
    if (index >= 0) {
      this.#keyOrder.splice(index, 1);
    }
    this.#queuedCount -= queue.length;
    for (const write of queue) {
      write.reject(error);
    }
    return true;
  }

  public close(error: Error = new WebRTCChannelClosedError()): void {
    if (this.#closedError) {
      return;
    }
    this.#closedError = error;
    this.#channel.removeEventListener('bufferedamountlow', this.#onBufferedAmountLow);
    this.#channel.removeEventListener('close', this.#onClose);
    this.#channel.removeEventListener('error', this.#onError);
    try {
      this.#channel.bufferedAmountLowThreshold = this.#previousLowThreshold;
    } catch {
      // Some implementations make the threshold immutable after closure.
    }
    for (const queue of this.#queues.values()) {
      for (const write of queue) {
        write.reject(error);
      }
    }
    this.#queues.clear();
    this.#keyOrder.length = 0;
    this.#queuedCount = 0;
  }

  #schedulePump(): void {
    if (this.#pumping || this.#closedError) {
      return;
    }
    queueMicrotask(() => {
      this.#pump();
    });
  }

  #dequeue(): QueuedWrite | undefined {
    const queueKey = this.#keyOrder.shift();
    if (queueKey === undefined) {
      return undefined;
    }
    const queue = this.#queues.get(queueKey);
    const write = queue?.shift();
    if (!queue || !write) {
      this.#queues.delete(queueKey);
      return undefined;
    }
    if (queue.length > 0) {
      this.#keyOrder.push(queueKey);
    } else {
      this.#queues.delete(queueKey);
    }
    this.#queuedCount -= 1;
    return write;
  }

  #pump(): void {
    if (this.#pumping || this.#closedError) {
      return;
    }
    this.#pumping = true;
    try {
      while (this.#queuedCount > 0) {
        if (this.#channel.readyState !== 'open') {
          this.close(new WebRTCChannelNotOpenError());
          return;
        }
        if (this.#channel.bufferedAmount > this.#options.highWatermark) {
          return;
        }
        const write = this.#dequeue();
        if (!write) {
          continue;
        }
        try {
          this.#channel.send(write.payload);
          write.resolve();
        } catch (cause) {
          const error = new WebRTCChannelNotOpenError('RTCDataChannel send failed', {
            cause,
          });
          write.reject(error);
          this.close(error);
          return;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }
}
