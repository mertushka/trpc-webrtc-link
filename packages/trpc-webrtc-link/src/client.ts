import { TRPCClientError, type TRPCLink } from '@trpc/client';
import type {
  AnyTRPCRouter,
  inferTRPCClientTypes,
  TRPCCombinedDataTransformer,
} from '@trpc/server';
import { observable } from '@trpc/server/observable';
import {
  assertReliableOrderedChannel,
  DataChannelWriter,
  waitForDataChannelOpen,
  type RTCDataChannelLike,
  type RTCDataChannelMessageEventLike,
  type WebRTCBackpressureOptions,
} from './channel.js';
import {
  WebRTCChannelClosedError,
  WebRTCHandshakeTimeoutError,
  WebRTCProtocolError,
  type WebRTCTransportError,
} from './errors.js';
import {
  parseWebRTCFrame,
  TRPC_WEBRTC_PROTOCOL,
  type WebRTCCancelFrame,
  type WebRTCErrorFrame,
  type WebRTCRequestFrame,
  type WebRTCRequestId,
  type WebRTCServerFrame,
} from './protocol.js';
import { normalizeTransformer, type WebRTCTransformer } from './trpc-internals.js';

type MaybePromise<T> = T | Promise<T>;

type WebRTCLinkTransformerOptions<TRouter extends AnyTRPCRouter> =
  inferTRPCClientTypes<TRouter>['transformer'] extends true
    ? { transformer: WebRTCTransformer }
    : { transformer?: WebRTCTransformer };

export type WebRTCDataChannelSource = RTCDataChannelLike | (() => MaybePromise<RTCDataChannelLike>);

export type CreateWebRTCLinkOptions<TRouter extends AnyTRPCRouter> = {
  /**
   * An established channel or a factory that resolves to one.
   */
  channel: WebRTCDataChannelSource;
  backpressure?: WebRTCBackpressureOptions;
  /**
   * Time allowed for both channel opening and protocol negotiation.
   * @default 10000
   */
  handshakeTimeoutMs?: number;
  /**
   * Called for malformed, unknown, duplicate, or unexpected inbound frames.
   */
  onProtocolError?: (error: WebRTCProtocolError) => void;
  /**
   * Close the underlying channel when the link's `close()` method is called.
   * @default false
   */
  closeChannelOnDispose?: boolean;
} & WebRTCLinkTransformerOptions<TRouter>;

export type WebRTCLink<TRouter extends AnyTRPCRouter> = TRPCLink<TRouter> & {
  close(reason?: Error): void;
};

interface ClientOperation {
  type: 'query' | 'mutation' | 'subscription';
  path: string;
  input: unknown;
  context: Record<string, unknown>;
  signal: AbortSignal | null;
}

interface ClientObserver {
  next(value: {
    result: { type: 'started' } | { type: 'stopped' } | { type: 'data'; data: unknown };
    context?: Record<string, unknown>;
  }): void;
  error(error: TRPCClientError<AnyTRPCRouter>): void;
  complete(): void;
}

interface PendingClientOperation {
  id: WebRTCRequestId;
  operation: ClientOperation;
  observer: ClientObserver;
  sent: boolean;
  started: boolean;
  hasResult: boolean;
  terminal: boolean;
  cleanup: () => void;
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(reason === undefined ? 'The operation was aborted' : String(reason));
  error.name = 'AbortError';
  return error;
}

function isErrorShape(value: unknown): value is {
  code: number;
  message: string;
  data: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'number' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

let fallbackRequestCounter = 0;

function randomRequestId(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  fallbackRequestCounter += 1;
  return [
    Date.now().toString(36),
    fallbackRequestCounter.toString(36),
    Math.random().toString(36).slice(2),
    Math.random().toString(36).slice(2),
  ].join('.');
}

class WebRTCClientTransport {
  readonly #source: WebRTCDataChannelSource;
  readonly #transformer: TRPCCombinedDataTransformer;
  readonly #backpressure: WebRTCBackpressureOptions | undefined;
  readonly #handshakeTimeoutMs: number;
  readonly #onProtocolError: ((error: WebRTCProtocolError) => void) | undefined;
  readonly #closeChannelOnDispose: boolean;
  readonly #pending = new Map<WebRTCRequestId, PendingClientOperation>();

  #channel: RTCDataChannelLike | null = null;
  #writer: DataChannelWriter | null = null;
  #initializePromise: Promise<void> | null = null;
  #state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle';
  #handshakeResolve: (() => void) | null = null;
  #handshakeReject: ((error: Error) => void) | null = null;

  readonly #onMessage = (event: RTCDataChannelMessageEventLike) => {
    this.#handleMessage(event.data);
  };

  readonly #onClose = () => {
    this.#failFatal(new WebRTCChannelClosedError());
  };

  readonly #onError = (cause: unknown) => {
    this.#failFatal(new WebRTCChannelClosedError('RTCDataChannel emitted an error', { cause }));
  };

  public constructor(
    options: CreateWebRTCLinkOptions<AnyTRPCRouter>,
    transformer: TRPCCombinedDataTransformer,
  ) {
    this.#source = options.channel;
    this.#transformer = transformer;
    this.#backpressure = options.backpressure;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.#onProtocolError = options.onProtocolError;
    this.#closeChannelOnDispose = options.closeChannelOnDispose ?? false;
  }

  public subscribe(operation: ClientOperation, observer: ClientObserver): () => void {
    let stopped = false;
    let id: WebRTCRequestId | null = null;

    const cleanupSignal = () => {
      operation.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      const error = createAbortError(operation.signal?.reason);
      if (id) {
        this.#cancelPending(id, error, true);
      } else {
        cleanupSignal();
        observer.error(this.#toClientError(error));
      }
    };

    if (operation.signal?.aborted) {
      onAbort();
      return cleanupSignal;
    }
    operation.signal?.addEventListener('abort', onAbort, { once: true });

    void this.#ensureReady()
      .then(() => {
        if (stopped) {
          return;
        }
        id = this.#createRequestId();
        const pending: PendingClientOperation = {
          id,
          operation,
          observer,
          sent: false,
          started: false,
          hasResult: false,
          terminal: false,
          cleanup: cleanupSignal,
        };
        this.#pending.set(id, pending);

        let input: unknown;
        try {
          input = this.#transformer.input.serialize(operation.input);
        } catch (cause) {
          this.#finishWithError(pending, cause);
          return;
        }

        const frame: WebRTCRequestFrame = {
          protocol: TRPC_WEBRTC_PROTOCOL,
          type: 'request',
          id,
          procedureType: operation.type,
          path: operation.path,
          ...(input === undefined ? {} : { input }),
        };
        void this.#writer!.send(frame, id).then(
          () => {
            pending.sent = true;
          },
          (error: Error) => {
            if (!pending.terminal) {
              this.#finishWithError(pending, error);
            }
          },
        );
      })
      .catch((error: Error) => {
        if (!stopped) {
          stopped = true;
          cleanupSignal();
          observer.error(this.#toClientError(error));
        }
      });

    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      cleanupSignal();
      if (id) {
        this.#cancelPending(id, createAbortError('The operation was unsubscribed'), false);
      }
    };
  }

  public close(reason: Error = new WebRTCChannelClosedError('WebRTC link was closed')): void {
    const channel = this.#channel;
    this.#failFatal(reason);
    if (this.#closeChannelOnDispose && channel && channel.readyState !== 'closed') {
      channel.close();
    }
  }

  async #ensureReady(): Promise<void> {
    if (this.#state === 'ready') {
      return;
    }
    if (this.#state === 'closed') {
      throw new WebRTCChannelClosedError('WebRTC link is closed');
    }
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  async #initialize(): Promise<void> {
    this.#state = 'connecting';
    try {
      const channel = typeof this.#source === 'function' ? await this.#source() : this.#source;
      assertReliableOrderedChannel(channel);
      await waitForDataChannelOpen(channel, this.#handshakeTimeoutMs);
      if (this.#isClosed()) {
        throw new WebRTCChannelClosedError('WebRTC link was closed while connecting');
      }

      this.#channel = channel;
      this.#writer = new DataChannelWriter(channel, this.#backpressure);
      channel.addEventListener('message', this.#onMessage);
      channel.addEventListener('close', this.#onClose);
      channel.addEventListener('error', this.#onError);

      const handshake = new Promise<void>((resolve, reject) => {
        this.#handshakeResolve = resolve;
        this.#handshakeReject = reject;
      });
      const timeout = setTimeout(() => {
        this.#handshakeReject?.(new WebRTCHandshakeTimeoutError(this.#handshakeTimeoutMs));
      }, this.#handshakeTimeoutMs);

      await this.#writer.send(
        {
          protocol: TRPC_WEBRTC_PROTOCOL,
          type: 'handshake',
          role: 'client',
        },
        'control',
      );
      await handshake.finally(() => {
        clearTimeout(timeout);
        this.#handshakeResolve = null;
        this.#handshakeReject = null;
      });
      this.#state = 'ready';
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.#failFatal(error);
      throw error;
    }
  }

  #createRequestId(): WebRTCRequestId {
    let id = randomRequestId();
    while (this.#pending.has(id)) {
      id = randomRequestId();
    }
    return id;
  }

  #handleMessage(data: unknown): void {
    const parsed = parseWebRTCFrame(data, this.#writer?.maxMessageBytes);
    if (!parsed.ok) {
      this.#protocolViolation(parsed.error.message, true);
      return;
    }
    const frame = parsed.frame;
    if (frame.type === 'handshake' || frame.type === 'request' || frame.type === 'cancel') {
      this.#protocolViolation(`Unexpected server frame: ${frame.type}`, true);
      return;
    }
    this.#handleServerFrame(frame);
  }

  #handleServerFrame(frame: WebRTCServerFrame): void {
    if (frame.type === 'ping') {
      void this.#writer
        ?.send(
          {
            protocol: TRPC_WEBRTC_PROTOCOL,
            type: 'pong',
            nonce: frame.nonce,
          },
          'control',
        )
        .catch((error: Error) => this.#failFatal(error));
      return;
    }
    if (frame.type === 'pong') {
      return;
    }
    if (frame.type === 'ready') {
      if (this.#state !== 'connecting' || !this.#handshakeResolve) {
        this.#protocolViolation('Received an unexpected ready frame', false);
        return;
      }
      this.#handshakeResolve();
      return;
    }
    if (frame.type === 'error' && frame.id === null) {
      const error = this.#clientErrorFromFrame(frame);
      this.#handshakeReject?.(error);
      this.#failFatal(error);
      return;
    }
    if (this.#state !== 'ready') {
      this.#protocolViolation(`Received ${frame.type} before ready`, true);
      return;
    }
    if (frame.id === null) {
      this.#protocolViolation('Received a response with a null operation id', true);
      return;
    }

    const pending = this.#pending.get(frame.id);
    if (!pending) {
      this.#protocolViolation(`Received ${frame.type} for unknown id ${frame.id}`, false);
      return;
    }

    switch (frame.type) {
      case 'result':
        this.#handleResult(pending, frame);
        return;
      case 'data':
        if (pending.operation.type !== 'subscription' || !pending.started) {
          this.#finishProtocolError(pending, 'Received subscription data in an invalid state');
          return;
        }
        try {
          pending.observer.next({
            result: {
              type: 'data',
              data: this.#transformer.output.deserialize(frame.data),
            },
            context: pending.operation.context,
          });
        } catch (cause) {
          this.#finishProtocolError(pending, 'Unable to deserialize subscription data', cause);
        }
        return;
      case 'error':
        this.#finishWithClientError(pending, this.#clientErrorFromFrame(frame));
        return;
      case 'complete':
        if (pending.operation.type !== 'subscription' && !pending.hasResult) {
          this.#finishProtocolError(pending, 'Operation completed without a result');
          return;
        }
        this.#pending.delete(pending.id);
        pending.terminal = true;
        pending.cleanup();
        if (pending.operation.type === 'subscription') {
          pending.observer.next({
            result: { type: 'stopped' },
            context: pending.operation.context,
          });
        }
        pending.observer.complete();
        return;
    }
  }

  #handleResult(
    pending: PendingClientOperation,
    frame: Extract<WebRTCServerFrame, { type: 'result' }>,
  ): void {
    if (frame.result === 'started') {
      if (pending.operation.type !== 'subscription' || pending.started) {
        this.#finishProtocolError(pending, 'Received an unexpected subscription start');
        return;
      }
      pending.started = true;
      pending.observer.next({
        result: { type: 'started' },
        context: pending.operation.context,
      });
      return;
    }
    if (pending.operation.type === 'subscription' || pending.hasResult) {
      this.#finishProtocolError(pending, 'Received an unexpected operation result');
      return;
    }
    try {
      pending.hasResult = true;
      pending.observer.next({
        result: {
          type: 'data',
          data: this.#transformer.output.deserialize(frame.data),
        },
        context: pending.operation.context,
      });
    } catch (cause) {
      this.#finishProtocolError(pending, 'Unable to deserialize operation result', cause);
    }
  }

  #clientErrorFromFrame(frame: WebRTCErrorFrame): TRPCClientError<AnyTRPCRouter> {
    try {
      const shape = this.#transformer.output.deserialize(frame.error);
      if (!isErrorShape(shape)) {
        throw new WebRTCProtocolError('Server returned an invalid tRPC error shape');
      }
      return TRPCClientError.from({
        error: shape,
      });
    } catch (cause) {
      return this.#toClientError(
        cause instanceof Error
          ? cause
          : new WebRTCProtocolError('Unable to deserialize server error'),
      );
    }
  }

  #cancelPending(id: WebRTCRequestId, error: Error, notifyObserver: boolean): void {
    const pending = this.#pending.get(id);
    if (!pending || pending.terminal) {
      return;
    }
    this.#pending.delete(id);
    pending.terminal = true;
    pending.cleanup();

    const removedBeforeSend = !pending.sent && this.#writer?.cancelKey(id, error);
    if (!removedBeforeSend) {
      const frame: WebRTCCancelFrame = {
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'cancel',
        id,
        reason: error.message.slice(0, 1024),
      };
      void this.#writer?.send(frame, id).catch((cause: Error) => {
        if (this.#state !== 'closed') {
          this.#notifyProtocolError(
            new WebRTCProtocolError(`Failed to send cancellation: ${cause.message}`, {
              cause,
            }),
          );
        }
      });
    }
    if (notifyObserver) {
      pending.observer.error(this.#toClientError(error));
    }
  }

  #finishWithError(pending: PendingClientOperation, cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    this.#finishWithClientError(pending, this.#toClientError(error));
  }

  #finishWithClientError(
    pending: PendingClientOperation,
    error: TRPCClientError<AnyTRPCRouter>,
  ): void {
    if (pending.terminal) {
      return;
    }
    this.#pending.delete(pending.id);
    pending.terminal = true;
    pending.cleanup();
    pending.observer.error(error);
  }

  #finishProtocolError(pending: PendingClientOperation, message: string, cause?: unknown): void {
    const error = new WebRTCProtocolError(message, cause === undefined ? undefined : { cause });
    this.#notifyProtocolError(error);
    this.#cancelPending(pending.id, error, true);
  }

  #protocolViolation(message: string, fatal: boolean): void {
    const error = new WebRTCProtocolError(message);
    this.#notifyProtocolError(error);
    if (fatal) {
      this.#failFatal(error);
      if (this.#channel && this.#channel.readyState !== 'closed') {
        this.#channel.close();
      }
    }
  }

  #notifyProtocolError(error: WebRTCProtocolError): void {
    try {
      this.#onProtocolError?.(error);
    } catch {
      // User callbacks must not break transport event processing.
    }
  }

  #toClientError(error: Error): TRPCClientError<AnyTRPCRouter> {
    const transportCode =
      'code' in error && typeof (error as WebRTCTransportError).code === 'string'
        ? (error as WebRTCTransportError).code
        : undefined;
    return TRPCClientError.from(error, {
      meta: {
        transport: 'webrtc',
        protocol: TRPC_WEBRTC_PROTOCOL,
        ...(transportCode ? { transportCode } : {}),
      },
    });
  }

  #failFatal(error: Error): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closed';
    this.#handshakeReject?.(error);
    this.#handshakeResolve = null;
    this.#handshakeReject = null;

    const channel = this.#channel;
    channel?.removeEventListener('message', this.#onMessage);
    channel?.removeEventListener('close', this.#onClose);
    channel?.removeEventListener('error', this.#onError);
    this.#writer?.close(error);

    for (const pending of this.#pending.values()) {
      pending.terminal = true;
      pending.cleanup();
      pending.observer.error(this.#toClientError(error));
    }
    this.#pending.clear();
  }

  #isClosed(): boolean {
    return this.#state === 'closed';
  }
}

export function createWebRTCLink<TRouter extends AnyTRPCRouter>(
  options: CreateWebRTCLinkOptions<TRouter>,
): WebRTCLink<TRouter> {
  const transformer = normalizeTransformer(options.transformer);
  const transport = new WebRTCClientTransport(
    options as CreateWebRTCLinkOptions<AnyTRPCRouter>,
    transformer,
  );

  const link: TRPCLink<TRouter> = () => {
    return ({ op }) => {
      return observable((observer) => {
        return transport.subscribe(op as ClientOperation, observer as ClientObserver);
      });
    };
  };

  return Object.assign(link, {
    close(reason?: Error) {
      transport.close(reason);
    },
  });
}
