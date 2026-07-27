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
  normalizeTimeoutMs,
  waitForDataChannelOpen,
  type RTCDataChannelLike,
  type RTCDataChannelMessageEventLike,
  type WebRTCBackpressureOptions,
} from './channel.js';
import {
  WebRTCChannelClosedError,
  WebRTCChannelNotOpenError,
  WebRTCHandshakeTimeoutError,
  WebRTCProtocolError,
  WebRTCReconnectExhaustedError,
  type WebRTCTransportError,
} from './errors.js';
import {
  HeartbeatController,
  normalizeKeepAliveOptions,
  type WebRTCKeepAliveOptions,
} from './heartbeat.js';
import {
  parseWebRTCFrame,
  TRPC_WEBRTC_PROTOCOL,
  type WebRTCCancelFrame,
  type WebRTCConnectionParams,
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

export interface WebRTCDataChannelFactoryOptions {
  /**
   * Aborted when the attempt times out, is replaced, or the link closes.
   */
  signal: AbortSignal;
  /**
   * Zero-based attempt index for the current connection cycle.
   */
  attempt: number;
  /**
   * The failure that caused this connection cycle, when reconnecting.
   */
  cause: Error | null;
}

export type WebRTCDataChannelFactory = (
  options: WebRTCDataChannelFactoryOptions,
) => MaybePromise<RTCDataChannelLike>;

export type WebRTCDataChannelSource = RTCDataChannelLike | WebRTCDataChannelFactory;

export interface WebRTCReconnectOptions {
  /**
   * Automatically replace a failed channel while subscriptions are active.
   * A channel factory is required.
   * @default false
   */
  enabled: boolean;
  /**
   * Maximum retry attempts after the first failed attempt.
   * @default Infinity
   */
  maxAttempts?: number;
  /**
   * Delay before each retry. The first retry receives index 0.
   */
  retryDelayMs?: (attemptIndex: number, error: Error) => number;
  /**
   * Decide whether a connection failure is retryable.
   * @default () => true
   */
  shouldRetry?: (options: { error: Error; attempt: number }) => boolean;
}

export interface WebRTCLazyOptions {
  /**
   * Delay invoking a channel factory until `connect()` or the first operation.
   * Direct channels always negotiate immediately.
   * @default false
   */
  enabled: boolean;
}

export type WebRTCLinkState =
  | {
      state: 'idle';
      error: Error | null;
    }
  | {
      state: 'connecting';
      attempt: number;
      error: Error | null;
    }
  | {
      state: 'open';
      channel: RTCDataChannelLike;
      reconnected: boolean;
      error: null;
    }
  | {
      state: 'closed';
      error: Error;
    };

export interface WebRTCLinkOpenOptions {
  channel: RTCDataChannelLike;
  reconnected: boolean;
}

export interface WebRTCLinkCloseOptions {
  channel: RTCDataChannelLike;
  error: Error;
  willReconnect: boolean;
}

export type CreateWebRTCLinkOptions<TRouter extends AnyTRPCRouter> = {
  /**
   * An established channel or a factory that creates a fresh channel for each
   * connection attempt. Applications remain responsible for SDP/ICE signaling.
   */
  channel: WebRTCDataChannelSource;
  backpressure?: WebRTCBackpressureOptions;
  /**
   * Total time allowed for channel creation, opening, connection parameters,
   * and protocol negotiation.
   * @default 10000
   */
  handshakeTimeoutMs?: number;
  connectionParams?:
    WebRTCConnectionParams | null | (() => MaybePromise<WebRTCConnectionParams | null>);
  reconnect?: boolean | WebRTCReconnectOptions;
  lazy?: boolean | WebRTCLazyOptions;
  keepAlive?: WebRTCKeepAliveOptions;
  /**
   * Called for malformed, unknown, duplicate, or unexpected inbound frames.
   */
  onProtocolError?: (error: WebRTCProtocolError) => void;
  onConnectionStateChange?: (state: WebRTCLinkState) => void;
  onOpen?: (options: WebRTCLinkOpenOptions) => void;
  onClose?: (options: WebRTCLinkCloseOptions) => void;
  onError?: (error: Error) => void;
  /**
   * Close the current channel when the link's `close()` method is called.
   * Failed and replaced channels are always closed.
   * @default false
   */
  closeChannelOnDispose?: boolean;
} & WebRTCLinkTransformerOptions<TRouter>;

export type WebRTCLink<TRouter extends AnyTRPCRouter> = TRPCLink<TRouter> & {
  /**
   * Establish the channel and complete protocol negotiation.
   */
  connect(): Promise<void>;
  /**
   * Replace the active channel with one from the configured factory.
   */
  reconnect(reason?: Error): Promise<void>;
  close(reason?: Error): void;
  readonly connectionState: WebRTCLinkState;
  subscribeConnectionState(listener: (state: WebRTCLinkState) => void): () => void;
};

interface ClientOperation {
  type: 'query' | 'mutation' | 'subscription';
  path: string;
  input: unknown;
  context: Record<string, unknown>;
  signal: AbortSignal | null;
}

type ClientResult =
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'data'; data: unknown; id?: string }
  | {
      type: 'state';
      state: 'idle' | 'connecting' | 'pending';
      error: TRPCClientError<AnyTRPCRouter> | null;
    };

interface ClientObserver {
  next(value: { result: ClientResult; context?: Record<string, unknown> }): void;
  error(error: TRPCClientError<AnyTRPCRouter>): void;
  complete(): void;
}

interface PendingClientOperation {
  id: WebRTCRequestId;
  operation: ClientOperation;
  observer: ClientObserver;
  sentGeneration: number | null;
  started: boolean;
  hasResult: boolean;
  terminal: boolean;
  lastEventId: string | undefined;
  cleanup: () => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface NormalizedReconnectOptions {
  enabled: boolean;
  maxAttempts: number;
  retryDelayMs(attemptIndex: number, error: Error): number;
  shouldRetry(options: { error: Error; attempt: number }): boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

function normalizeReconnectOptions(
  value: boolean | WebRTCReconnectOptions | undefined,
): NormalizedReconnectOptions {
  const options = typeof value === 'object' ? value : undefined;
  const enabled = typeof value === 'boolean' ? value : (options?.enabled ?? false);
  const maxAttempts = options?.maxAttempts ?? Number.POSITIVE_INFINITY;
  if (
    maxAttempts !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)
  ) {
    throw new RangeError('reconnect.maxAttempts must be a non-negative safe integer or Infinity');
  }
  return {
    enabled,
    maxAttempts,
    retryDelayMs:
      options?.retryDelayMs ??
      ((attemptIndex) => (attemptIndex === 0 ? 0 : Math.min(1_000 * 2 ** attemptIndex, 30_000))),
    shouldRetry: options?.shouldRetry ?? (() => true),
  };
}

function normalizeDelayMs(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Reconnect delay must be a finite non-negative number');
  }
  return Math.min(value, 2_147_483_647);
}

async function waitWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw getSignalReason(signal);
  }
  if (delayMs === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(getSignalReason(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw getSignalReason(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(getSignalReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function getSignalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new WebRTCChannelClosedError('WebRTC connection attempt was aborted', {
        cause: signal.reason,
      });
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
  readonly #connectionParams:
    CreateWebRTCLinkOptions<AnyTRPCRouter>['connectionParams'] | undefined;
  readonly #reconnectOptions: NormalizedReconnectOptions;
  readonly #keepAliveOptions: ReturnType<typeof normalizeKeepAliveOptions>;
  readonly #onProtocolError: ((error: WebRTCProtocolError) => void) | undefined;
  readonly #onConnectionStateChange: ((state: WebRTCLinkState) => void) | undefined;
  readonly #onOpen: ((options: WebRTCLinkOpenOptions) => void) | undefined;
  readonly #onClose: ((options: WebRTCLinkCloseOptions) => void) | undefined;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #closeChannelOnDispose: boolean;
  readonly #pending = new Map<WebRTCRequestId, PendingClientOperation>();
  readonly #stateListeners = new Set<(state: WebRTCLinkState) => void>();
  readonly #lifecycleController = new AbortController();

  #connectionState: WebRTCLinkState = { state: 'idle', error: null };
  #channel: RTCDataChannelLike | null = null;
  #writer: DataChannelWriter | null = null;
  #heartbeat: HeartbeatController | null = null;
  #handshake: Deferred<void> | null = null;
  #connectPromise: Promise<void> | null = null;
  #attemptController: AbortController | null = null;
  #generation = 0;
  #hasConnected = false;
  #listeners: {
    channel: RTCDataChannelLike;
    message(event: RTCDataChannelMessageEventLike): void;
    close(): void;
    error(cause: unknown): void;
  } | null = null;

  public constructor(
    options: CreateWebRTCLinkOptions<AnyTRPCRouter>,
    transformer: TRPCCombinedDataTransformer,
  ) {
    this.#source = options.channel;
    this.#transformer = transformer;
    this.#backpressure = options.backpressure;
    this.#handshakeTimeoutMs = normalizeTimeoutMs(
      options.handshakeTimeoutMs ?? 10_000,
      'handshakeTimeoutMs',
    );
    this.#connectionParams = options.connectionParams;
    this.#reconnectOptions = normalizeReconnectOptions(options.reconnect);
    if (this.#reconnectOptions.enabled && typeof this.#source !== 'function') {
      throw new TypeError('Automatic reconnection requires a channel factory');
    }
    this.#keepAliveOptions = normalizeKeepAliveOptions(options.keepAlive, {
      intervalMs: 5_000,
      pongTimeoutMs: 1_000,
    });
    this.#onProtocolError = options.onProtocolError;
    this.#onConnectionStateChange = options.onConnectionStateChange;
    this.#onOpen = options.onOpen;
    this.#onClose = options.onClose;
    this.#onError = options.onError;
    this.#closeChannelOnDispose = options.closeChannelOnDispose ?? false;
  }

  public get connectionState(): WebRTCLinkState {
    return this.#connectionState;
  }

  public subscribeConnectionState(listener: (state: WebRTCLinkState) => void): () => void {
    this.#stateListeners.add(listener);
    this.#safeCallback(() => listener(this.#connectionState));
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  public connect(): Promise<void> {
    return this.#ensureConnected(this.#connectionState.error, this.#reconnectOptions.enabled);
  }

  public async reconnect(
    reason: Error = new WebRTCChannelClosedError('WebRTC link was asked to reconnect'),
  ): Promise<void> {
    if (typeof this.#source !== 'function') {
      throw new TypeError('Reconnection requires a channel factory');
    }
    if (this.#connectionState.state === 'closed') {
      throw this.#connectionState.error;
    }
    if (this.#connectionState.state === 'open') {
      this.#loseConnection(reason, true, true);
    } else {
      const activeConnection = this.#connectPromise;
      this.#attemptController?.abort(reason);
      await activeConnection?.catch(() => undefined);
    }
    await this.#ensureConnected(reason, true);
  }

  public subscribe(operation: ClientOperation, observer: ClientObserver): () => void {
    let stopped = false;
    const id = this.#createRequestId();
    const cleanupSignal = () => {
      operation.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      this.#cancelPending(id, createAbortError(operation.signal?.reason), true);
    };

    if (operation.signal?.aborted) {
      onAbort();
      return cleanupSignal;
    }

    const pending: PendingClientOperation = {
      id,
      operation,
      observer,
      sentGeneration: null,
      started: false,
      hasResult: false,
      terminal: false,
      lastEventId: undefined,
      cleanup: cleanupSignal,
    };
    this.#pending.set(id, pending);
    operation.signal?.addEventListener('abort', onAbort, { once: true });

    if (operation.type === 'subscription') {
      this.#emitConnectionState(pending);
    }

    if (this.#isReady()) {
      this.#sendPending(pending);
    } else {
      void this.#ensureConnected(this.#connectionState.error, this.#reconnectOptions.enabled).catch(
        (error: unknown) => {
          if (!pending.terminal) {
            this.#finishWithError(pending, error);
          }
        },
      );
    }

    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      this.#cancelPending(id, createAbortError('The operation was unsubscribed'), false);
    };
  }

  public close(reason: Error = new WebRTCChannelClosedError('WebRTC link was closed')): void {
    if (this.#connectionState.state === 'closed') {
      return;
    }
    const channel = this.#channel;
    this.#lifecycleController.abort(reason);
    this.#attemptController?.abort(reason);
    this.#cleanupConnection(reason);
    for (const pending of [...this.#pending.values()]) {
      this.#finishWithError(pending, reason);
    }
    this.#setState({ state: 'closed', error: reason });
    if (channel) {
      this.#safeCallback(() =>
        this.#onClose?.({
          channel,
          error: reason,
          willReconnect: false,
        }),
      );
      if (this.#closeChannelOnDispose && channel.readyState !== 'closed') {
        channel.close();
      }
    }
  }

  async #ensureConnected(cause: Error | null, allowRetries: boolean): Promise<void> {
    if (this.#isReady()) {
      return;
    }
    if (this.#connectionState.state === 'closed') {
      throw this.#connectionState.error;
    }
    if (this.#connectPromise) {
      return this.#connectPromise;
    }
    const promise = this.#connectLoop(cause, allowRetries);
    this.#connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this.#connectPromise === promise) {
        this.#connectPromise = null;
      }
    }
  }

  async #connectLoop(initialCause: Error | null, allowRetries: boolean): Promise<void> {
    let attempt = 0;
    let cause = initialCause;
    while (true) {
      if (this.#lifecycleController.signal.aborted) {
        throw getSignalReason(this.#lifecycleController.signal);
      }
      if (attempt > 0) {
        try {
          const retryDelay = normalizeDelayMs(
            this.#reconnectOptions.retryDelayMs(attempt - 1, cause!),
          );
          await waitWithSignal(retryDelay, this.#lifecycleController.signal);
        } catch (caught) {
          const error = caught instanceof Error ? caught : new Error(String(caught));
          if (this.#lifecycleController.signal.aborted) {
            throw getSignalReason(this.#lifecycleController.signal);
          }
          this.#setState({ state: 'idle', error });
          this.#safeCallback(() => this.#onError?.(error));
          throw error;
        }
      }
      this.#setState({
        state: 'connecting',
        attempt,
        error: cause,
      });
      try {
        await this.#connectAttempt(attempt, cause);
        return;
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        if (this.#lifecycleController.signal.aborted) {
          throw getSignalReason(this.#lifecycleController.signal);
        }
        this.#safeCallback(() => this.#onError?.(error));
        const canRetry =
          allowRetries &&
          typeof this.#source === 'function' &&
          attempt < this.#reconnectOptions.maxAttempts &&
          this.#safeShouldRetry(error, attempt);
        if (!canRetry) {
          const finalError =
            allowRetries &&
            this.#reconnectOptions.maxAttempts !== Number.POSITIVE_INFINITY &&
            attempt >= this.#reconnectOptions.maxAttempts
              ? new WebRTCReconnectExhaustedError(attempt + 1, { cause: error })
              : error;
          this.#setState({ state: 'idle', error: finalError });
          throw finalError;
        }
        cause = error;
        attempt += 1;
      }
    }
  }

  async #connectAttempt(attempt: number, cause: Error | null): Promise<void> {
    const controller = new AbortController();
    this.#attemptController = controller;
    const onLifecycleAbort = () => {
      controller.abort(getSignalReason(this.#lifecycleController.signal));
    };
    this.#lifecycleController.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    const timeoutError = new WebRTCHandshakeTimeoutError(this.#handshakeTimeoutMs);
    const timeout = setTimeout(() => controller.abort(timeoutError), this.#handshakeTimeoutMs);
    let channel: RTCDataChannelLike | null = null;

    try {
      const sourcePromise = Promise.resolve(
        typeof this.#source === 'function'
          ? this.#source({
              signal: controller.signal,
              attempt,
              cause,
            })
          : this.#source,
      );
      void sourcePromise.then(
        (lateChannel) => {
          if (controller.signal.aborted && lateChannel.readyState !== 'closed') {
            lateChannel.close();
          }
        },
        () => undefined,
      );
      channel = await raceWithSignal(sourcePromise, controller.signal);
      assertReliableOrderedChannel(channel);
      await waitForDataChannelOpen(channel, this.#handshakeTimeoutMs, controller.signal);

      const rawConnectionParams =
        typeof this.#connectionParams === 'function'
          ? await raceWithSignal(Promise.resolve(this.#connectionParams()), controller.signal)
          : (this.#connectionParams ?? null);

      const writer = new DataChannelWriter(channel, this.#backpressure);
      const handshake = deferred<void>();
      this.#channel = channel;
      this.#writer = writer;
      this.#handshake = handshake;
      this.#attachConnectionListeners(channel);

      await writer.send(
        {
          protocol: TRPC_WEBRTC_PROTOCOL,
          type: 'handshake',
          role: 'client',
          ...(rawConnectionParams ? { connectionParams: rawConnectionParams } : {}),
        },
        'control',
      );
      await raceWithSignal(handshake.promise, controller.signal);
      if (this.#channel !== channel) {
        throw new WebRTCChannelClosedError('RTCDataChannel was replaced during handshake');
      }

      this.#generation += 1;
      const reconnected = this.#hasConnected;
      this.#hasConnected = true;
      this.#heartbeat = new HeartbeatController({
        keepAlive: this.#keepAliveOptions,
        sendPing: async (nonce) => {
          await this.#writer?.send(
            {
              protocol: TRPC_WEBRTC_PROTOCOL,
              type: 'ping',
              nonce,
            },
            'control',
          );
        },
        onFailure: (error) => {
          if (this.#channel === channel) {
            this.#loseConnection(error, this.#shouldAutomaticallyReconnect());
          }
        },
      });
      this.#heartbeat.start();
      this.#setState({
        state: 'open',
        channel,
        reconnected,
        error: null,
      });
      const connectedChannel = channel;
      this.#safeCallback(() => this.#onOpen?.({ channel: connectedChannel, reconnected }));
      this.#flushPending();
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (this.#channel === channel) {
        this.#cleanupConnection(error);
      }
      if (channel && channel.readyState !== 'closed') {
        channel.close();
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#lifecycleController.signal.removeEventListener('abort', onLifecycleAbort);
      if (this.#attemptController === controller) {
        this.#attemptController = null;
      }
    }
  }

  #attachConnectionListeners(channel: RTCDataChannelLike): void {
    const listeners = {
      channel,
      message: (event: RTCDataChannelMessageEventLike) => {
        if (this.#channel === channel) {
          this.#handleMessage(event.data);
        }
      },
      close: () => {
        if (this.#channel === channel) {
          this.#handleChannelFailure(channel, new WebRTCChannelClosedError());
        }
      },
      error: (cause: unknown) => {
        if (this.#channel === channel) {
          this.#handleChannelFailure(
            channel,
            new WebRTCChannelClosedError('RTCDataChannel emitted an error', { cause }),
          );
        }
      },
    };
    this.#listeners = listeners;
    channel.addEventListener('message', listeners.message);
    channel.addEventListener('close', listeners.close);
    channel.addEventListener('error', listeners.error);
  }

  #handleChannelFailure(channel: RTCDataChannelLike, error: Error): void {
    if (this.#connectionState.state === 'open') {
      this.#loseConnection(error, this.#shouldAutomaticallyReconnect());
      return;
    }
    this.#handshake?.reject(error);
    this.#cleanupConnection(error);
    if (channel.readyState !== 'closed') {
      channel.close();
    }
  }

  #loseConnection(error: Error, preserveSubscriptions: boolean, forceReconnect = false): void {
    const channel = this.#channel;
    if (!channel || this.#connectionState.state === 'closed') {
      return;
    }
    const hasActiveSubscription = [...this.#pending.values()].some(
      (pending) => pending.operation.type === 'subscription' && !pending.terminal,
    );
    const willReconnect =
      typeof this.#source === 'function' &&
      (forceReconnect || (preserveSubscriptions && hasActiveSubscription));
    this.#cleanupConnection(error);
    if (channel.readyState !== 'closed') {
      channel.close();
    }
    this.#safeCallback(() => this.#onError?.(error));
    this.#safeCallback(() => this.#onClose?.({ channel, error, willReconnect }));

    this.#setState(
      willReconnect ? { state: 'connecting', attempt: 0, error } : { state: 'idle', error },
    );
    for (const pending of [...this.#pending.values()]) {
      if (preserveSubscriptions && willReconnect && pending.operation.type === 'subscription') {
        pending.sentGeneration = null;
        pending.started = false;
        continue;
      }
      this.#finishWithError(pending, error);
    }

    if (willReconnect) {
      void this.#ensureConnected(error, true).catch((cause: unknown) => {
        const finalError = cause instanceof Error ? cause : new Error(String(cause));
        for (const pending of [...this.#pending.values()]) {
          if (pending.operation.type === 'subscription') {
            this.#finishWithError(pending, finalError);
          }
        }
      });
    }
  }

  #cleanupConnection(error: Error): void {
    this.#heartbeat?.stop();
    this.#heartbeat = null;
    this.#handshake?.reject(error);
    this.#handshake = null;
    const listeners = this.#listeners;
    if (listeners) {
      listeners.channel.removeEventListener('message', listeners.message);
      listeners.channel.removeEventListener('close', listeners.close);
      listeners.channel.removeEventListener('error', listeners.error);
      this.#listeners = null;
    }
    this.#writer?.close(error);
    this.#writer = null;
    this.#channel = null;
  }

  #flushPending(): void {
    for (const pending of this.#pending.values()) {
      if (!pending.terminal && pending.sentGeneration !== this.#generation) {
        this.#sendPending(pending);
      }
    }
  }

  #sendPending(pending: PendingClientOperation): void {
    const writer = this.#writer;
    if (!writer || !this.#isReady() || pending.terminal) {
      return;
    }
    let input: unknown;
    try {
      input = this.#transformer.input.serialize(pending.operation.input);
    } catch (cause) {
      this.#finishWithError(pending, cause);
      return;
    }

    const frame: WebRTCRequestFrame = {
      protocol: TRPC_WEBRTC_PROTOCOL,
      type: 'request',
      id: pending.id,
      procedureType: pending.operation.type,
      path: pending.operation.path,
      ...(input === undefined ? {} : { input }),
      ...(pending.operation.type === 'subscription' && pending.lastEventId
        ? { lastEventId: pending.lastEventId }
        : {}),
    };
    pending.sentGeneration = this.#generation;
    void writer.send(frame, pending.id).catch((error: Error) => {
      if (pending.terminal) {
        return;
      }
      if (this.#isFatalWriteError(error)) {
        this.#loseConnection(error, this.#shouldAutomaticallyReconnect());
      } else {
        this.#finishWithError(pending, error);
      }
    });
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
    if (frame.type === 'pong') {
      this.#heartbeat?.pong(frame.nonce);
      return;
    }
    this.#heartbeat?.activity();
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
        .catch((error: Error) => this.#loseConnection(error, this.#shouldAutomaticallyReconnect()));
      return;
    }
    if (frame.type === 'pong') {
      return;
    }
    if (frame.type === 'reconnect') {
      const error = new WebRTCChannelClosedError(
        frame.reason ? `Server requested reconnect: ${frame.reason}` : 'Server requested reconnect',
      );
      if (typeof this.#source === 'function') {
        void this.reconnect(error).catch(() => undefined);
      } else {
        this.#loseConnection(error, false);
      }
      return;
    }
    if (frame.type === 'ready') {
      if (this.#connectionState.state !== 'connecting' || !this.#handshake) {
        this.#protocolViolation('Received an unexpected ready frame', false);
        return;
      }
      this.#handshake.resolve();
      return;
    }
    if (frame.type === 'error' && frame.id === null) {
      const error = this.#clientErrorFromFrame(frame);
      if (this.#connectionState.state === 'connecting') {
        this.#handshake?.reject(error);
      } else {
        this.#loseConnection(error, false);
      }
      return;
    }
    if (!this.#isReady()) {
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
          const data = this.#transformer.output.deserialize(frame.data);
          if (frame.eventId) {
            pending.lastEventId = frame.eventId;
          }
          pending.observer.next({
            result: {
              type: 'data',
              data,
              ...(frame.eventId ? { id: frame.eventId } : {}),
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
        if (pending.operation.type === 'subscription' && !pending.started) {
          this.#finishProtocolError(pending, 'Subscription completed before it started');
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

    const writer = this.#writer;
    const wasSent = pending.sentGeneration === this.#generation;
    const removedBeforeSend = wasSent && writer?.cancelKey(id, error);
    if (wasSent && !removedBeforeSend && writer && this.#isReady()) {
      const frame: WebRTCCancelFrame = {
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'cancel',
        id,
        reason: error.message.slice(0, 1024),
      };
      void writer.send(frame, id).catch((cause: Error) => {
        if (this.#connectionState.state !== 'closed') {
          if (this.#isFatalWriteError(cause)) {
            this.#loseConnection(cause, this.#shouldAutomaticallyReconnect());
          } else {
            this.#notifyProtocolError(
              new WebRTCProtocolError(`Failed to send cancellation: ${cause.message}`, {
                cause,
              }),
            );
          }
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
      this.#loseConnection(error, false);
    }
  }

  #notifyProtocolError(error: WebRTCProtocolError): void {
    this.#safeCallback(() => this.#onProtocolError?.(error));
  }

  #setState(state: WebRTCLinkState): void {
    this.#connectionState = state;
    this.#safeCallback(() => this.#onConnectionStateChange?.(state));
    for (const listener of this.#stateListeners) {
      this.#safeCallback(() => listener(state));
    }
    for (const pending of this.#pending.values()) {
      if (pending.operation.type === 'subscription' && !pending.terminal) {
        this.#emitConnectionState(pending);
      }
    }
  }

  #emitConnectionState(pending: PendingClientOperation): void {
    const state = this.#connectionState;
    let result: Extract<ClientResult, { type: 'state' }>;
    if (state.state === 'open') {
      result = {
        type: 'state',
        state: 'pending',
        error: null,
      };
    } else if (state.state === 'connecting') {
      result = {
        type: 'state',
        state: 'connecting',
        error: state.error ? this.#toClientError(state.error) : null,
      };
    } else {
      result = {
        type: 'state',
        state: 'idle',
        error: null,
      };
    }
    pending.observer.next({
      result,
      context: pending.operation.context,
    });
  }

  #toClientError(error: Error): TRPCClientError<AnyTRPCRouter> {
    if (error instanceof TRPCClientError) {
      return error;
    }
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

  #createRequestId(): WebRTCRequestId {
    let id = randomRequestId();
    while (this.#pending.has(id)) {
      id = randomRequestId();
    }
    return id;
  }

  #isFatalWriteError(error: Error): boolean {
    return error instanceof WebRTCChannelClosedError || error instanceof WebRTCChannelNotOpenError;
  }

  #isReady(): boolean {
    return this.#connectionState.state === 'open' && this.#channel !== null;
  }

  #shouldAutomaticallyReconnect(): boolean {
    return (
      this.#reconnectOptions.enabled &&
      typeof this.#source === 'function' &&
      [...this.#pending.values()].some(
        (pending) => pending.operation.type === 'subscription' && !pending.terminal,
      )
    );
  }

  #safeShouldRetry(error: Error, attempt: number): boolean {
    try {
      return this.#reconnectOptions.shouldRetry({ error, attempt });
    } catch {
      return false;
    }
  }

  #safeCallback(callback: () => void): void {
    try {
      callback();
    } catch {
      // User callbacks must not break transport processing.
    }
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

  const result = Object.assign(link, {
    connect() {
      return transport.connect();
    },
    reconnect(reason?: Error) {
      return transport.reconnect(reason);
    },
    close(reason?: Error) {
      transport.close(reason);
    },
    subscribeConnectionState(listener: (state: WebRTCLinkState) => void) {
      return transport.subscribeConnectionState(listener);
    },
  });
  Object.defineProperty(result, 'connectionState', {
    enumerable: true,
    get() {
      return transport.connectionState;
    },
  });

  const lazyEnabled =
    typeof options.lazy === 'boolean' ? options.lazy : (options.lazy?.enabled ?? false);
  if (typeof options.channel !== 'function' || !lazyEnabled) {
    void transport.connect().catch(() => undefined);
  }

  return result as WebRTCLink<TRouter>;
}
