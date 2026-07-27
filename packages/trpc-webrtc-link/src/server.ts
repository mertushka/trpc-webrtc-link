import {
  callTRPCProcedure,
  getTRPCErrorFromUnknown,
  isTrackedEnvelope,
  TRPCError,
  type AnyTRPCRouter,
  type inferRouterContext,
  type TRPCProcedureType,
} from '@trpc/server';
import { isObservable, observableToAsyncIterable } from '@trpc/server/observable';
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
} from './errors.js';
import {
  HeartbeatController,
  normalizeKeepAliveOptions,
  type WebRTCKeepAliveOptions,
} from './heartbeat.js';
import {
  parseWebRTCFrame,
  TRPC_WEBRTC_PROTOCOL,
  type WebRTCClientFrame,
  type WebRTCConnectionParams,
  type WebRTCErrorFrame,
  type WebRTCHandshakeFrame,
  type WebRTCRequestFrame,
  type WebRTCRequestId,
} from './protocol.js';
import { getRouterTransformer, shapeRouterError } from './trpc-internals.js';

type MaybePromise<T> = T | Promise<T>;

export interface CreateWebRTCContextOptions<TPeer = unknown> {
  channel: RTCDataChannelLike;
  peer: TPeer;
  connectionParams: WebRTCConnectionParams | null;
  signal: AbortSignal;
}

export interface WebRTCHandlerErrorOptions<TRouter extends AnyTRPCRouter, TPeer = unknown> {
  error: TRPCError;
  type: TRPCProcedureType | 'unknown';
  path: string | undefined;
  input: unknown;
  ctx: inferRouterContext<TRouter> | undefined;
  channel: RTCDataChannelLike;
  peer: TPeer;
}

export interface CreateWebRTCHandlerOptions<TRouter extends AnyTRPCRouter, TPeer = unknown> {
  router: TRouter;
  channel: RTCDataChannelLike;
  peer: TPeer;
  createContext?: (
    options: CreateWebRTCContextOptions<TPeer>,
  ) => MaybePromise<inferRouterContext<TRouter>>;
  onError?: (options: WebRTCHandlerErrorOptions<TRouter, TPeer>) => void;
  onProtocolError?: (error: WebRTCProtocolError) => void;
  backpressure?: WebRTCBackpressureOptions;
  keepAlive?: WebRTCKeepAliveOptions;
  /**
   * Reject additional requests after this many operations are active.
   * @default Infinity
   */
  maxConcurrentOperations?: number;
  /**
   * Time allowed for the channel to open.
   * @default 10000
   */
  openTimeoutMs?: number;
  /**
   * Time allowed after opening for protocol negotiation and context creation.
   * @default 10000
   */
  handshakeTimeoutMs?: number;
}

export interface WebRTCHandler {
  /**
   * Resolves after context creation and protocol negotiation.
   */
  readonly ready: Promise<void>;
  /**
   * Ask the client to replace this channel. Applications can call this before
   * rotating a server or expiring a peer connection.
   */
  requestReconnect(reason?: string): Promise<void>;
  /**
   * Abort active procedures and remove all channel listeners.
   */
  close(options?: { closeChannel?: boolean; reason?: Error }): void;
}

interface ActiveServerOperation {
  controller: AbortController;
  request: WebRTCRequestFrame;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
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

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  );
}

async function nextWithAbort(
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal,
): Promise<IteratorResult<unknown> | 'aborted'> {
  if (signal.aborted) {
    return 'aborted';
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      resolve('aborted');
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeMaxConcurrentOperations(value: number | undefined): number {
  if (value === undefined || value === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('maxConcurrentOperations must be a positive safe integer or Infinity');
  }
  return value;
}

function injectLastEventId(input: unknown, lastEventId: string | undefined): unknown {
  if (!lastEventId || (input !== null && input !== undefined && typeof input !== 'object')) {
    return input;
  }
  return {
    ...(input ?? {}),
    lastEventId,
  };
}

class WebRTCServerHandler<TRouter extends AnyTRPCRouter, TPeer> implements WebRTCHandler {
  readonly #options: CreateWebRTCHandlerOptions<TRouter, TPeer>;
  readonly #router: TRouter;
  readonly #channel: RTCDataChannelLike;
  readonly #peer: TPeer;
  readonly #writer: DataChannelWriter;
  readonly #contextController = new AbortController();
  readonly #active = new Map<WebRTCRequestId, ActiveServerOperation>();
  readonly #readyDeferred = deferred<void>();
  readonly #openTimeoutMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #maxConcurrentOperations: number;
  readonly #heartbeat: HeartbeatController;
  readonly ready: Promise<void>;

  #state: 'awaiting_open' | 'awaiting_handshake' | 'creating_context' | 'ready' | 'closed' =
    'awaiting_open';
  #ctx: inferRouterContext<TRouter> | undefined;
  #connectionParams: WebRTCConnectionParams | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  readonly #onMessage = (event: RTCDataChannelMessageEventLike) => {
    this.#handleMessage(event.data);
  };

  readonly #onClose = () => {
    this.close({
      reason: new WebRTCChannelClosedError(),
    });
  };

  readonly #onChannelError = (cause: unknown) => {
    this.close({
      reason: new WebRTCChannelClosedError('RTCDataChannel emitted an error', { cause }),
    });
  };

  public constructor(options: CreateWebRTCHandlerOptions<TRouter, TPeer>) {
    this.#options = options;
    this.#router = options.router;
    this.#channel = options.channel;
    this.#peer = options.peer;
    this.#openTimeoutMs = normalizeTimeoutMs(options.openTimeoutMs ?? 10_000, 'openTimeoutMs');
    this.#handshakeTimeoutMs = normalizeTimeoutMs(
      options.handshakeTimeoutMs ?? 10_000,
      'handshakeTimeoutMs',
    );
    this.#maxConcurrentOperations = normalizeMaxConcurrentOperations(
      options.maxConcurrentOperations,
    );
    assertReliableOrderedChannel(this.#channel);
    this.#writer = new DataChannelWriter(this.#channel, options.backpressure);
    this.#heartbeat = new HeartbeatController({
      keepAlive: normalizeKeepAliveOptions(options.keepAlive, {
        intervalMs: 30_000,
        pongTimeoutMs: 5_000,
      }),
      sendPing: async (nonce) => {
        await this.#writer.send(
          {
            protocol: TRPC_WEBRTC_PROTOCOL,
            type: 'ping',
            nonce,
          },
          'control',
        );
      },
      onFailure: (error) => {
        this.close({
          closeChannel: true,
          reason: error,
        });
      },
    });
    this.ready = this.#readyDeferred.promise;
    void this.ready.catch(() => {
      // Readiness is optional for callers that rely on channel closure.
    });

    this.#channel.addEventListener('message', this.#onMessage);
    this.#channel.addEventListener('close', this.#onClose);
    this.#channel.addEventListener('error', this.#onChannelError);
    void this.#initialize();
  }

  public async requestReconnect(reason?: string): Promise<void> {
    if (this.#state !== 'ready') {
      throw new WebRTCChannelNotOpenError('WebRTC handler is not ready');
    }
    await this.#writer.send(
      {
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'reconnect',
        ...(reason ? { reason: reason.slice(0, 1024) } : {}),
      },
      'control',
    );
  }

  public close(options: { closeChannel?: boolean; reason?: Error } = {}): void {
    if (this.#state === 'closed') {
      return;
    }
    const reason = options.reason ?? new WebRTCChannelClosedError('WebRTC handler was closed');
    const wasReady = this.#state === 'ready';
    this.#state = 'closed';
    if (this.#handshakeTimer !== undefined) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
    }
    this.#heartbeat.stop();
    this.#channel.removeEventListener('message', this.#onMessage);
    this.#channel.removeEventListener('close', this.#onClose);
    this.#channel.removeEventListener('error', this.#onChannelError);
    this.#writer.close(reason);
    this.#contextController.abort(reason);
    for (const operation of this.#active.values()) {
      operation.controller.abort(reason);
    }
    this.#active.clear();
    if (!wasReady) {
      this.#readyDeferred.reject(reason);
    }
    if (options.closeChannel && this.#channel.readyState !== 'closed') {
      this.#channel.close();
    }
  }

  async #initialize(): Promise<void> {
    try {
      await waitForDataChannelOpen(
        this.#channel,
        this.#openTimeoutMs,
        this.#contextController.signal,
      );
      if (this.#state !== 'closed') {
        this.#state = 'awaiting_handshake';
        this.#handshakeTimer = setTimeout(() => {
          this.close({
            closeChannel: true,
            reason: new WebRTCHandshakeTimeoutError(this.#handshakeTimeoutMs),
          });
        }, this.#handshakeTimeoutMs);
      }
    } catch (cause) {
      this.close({
        closeChannel: true,
        reason: cause instanceof Error ? cause : new Error(String(cause)),
      });
    }
  }

  #handleMessage(data: unknown): void {
    if (this.#state === 'closed') {
      return;
    }
    const parsed = parseWebRTCFrame(data, this.#writer.maxMessageBytes);
    if (!parsed.ok) {
      void this.#fatalProtocolError(parsed.error.message);
      return;
    }
    const frame = parsed.frame;
    if (
      frame.type === 'ready' ||
      frame.type === 'result' ||
      frame.type === 'data' ||
      frame.type === 'error' ||
      frame.type === 'complete' ||
      frame.type === 'reconnect'
    ) {
      void this.#fatalProtocolError(`Unexpected client frame: ${frame.type}`);
      return;
    }
    if (frame.type === 'pong') {
      this.#heartbeat.pong(frame.nonce);
      return;
    }
    this.#heartbeat.activity();
    void this.#handleClientFrame(frame).catch((cause: unknown) => {
      this.close({
        closeChannel: true,
        reason: cause instanceof Error ? cause : new Error(String(cause)),
      });
    });
  }

  async #handleClientFrame(frame: WebRTCClientFrame): Promise<void> {
    if (frame.type === 'ping') {
      await this.#writer.send(
        {
          protocol: TRPC_WEBRTC_PROTOCOL,
          type: 'pong',
          nonce: frame.nonce,
        },
        'control',
      );
      return;
    }
    if (frame.type === 'pong') {
      return;
    }
    if (frame.type === 'handshake') {
      await this.#handleHandshake(frame);
      return;
    }
    if (this.#state !== 'ready') {
      await this.#fatalProtocolError(`Received ${frame.type} before handshake completion`);
      return;
    }
    if (frame.type === 'cancel') {
      const operation = this.#active.get(frame.id);
      if (!operation) {
        this.#notifyProtocolError(
          new WebRTCProtocolError(`Received cancellation for unknown id ${frame.id}`),
        );
        return;
      }
      const cancellationError = createCancellationError(frame.reason);
      operation.controller.abort(cancellationError);
      this.#writer.cancelKey(frame.id, cancellationError);
      return;
    }
    this.#handleRequest(frame);
  }

  async #handleHandshake(frame: WebRTCHandshakeFrame): Promise<void> {
    if (this.#state !== 'awaiting_handshake') {
      await this.#fatalProtocolError('Received a duplicate or unexpected handshake');
      return;
    }
    this.#state = 'creating_context';
    this.#connectionParams = frame.connectionParams ?? null;
    try {
      this.#ctx = this.#options.createContext
        ? await this.#options.createContext({
            channel: this.#channel,
            peer: this.#peer,
            connectionParams: this.#connectionParams,
            signal: this.#contextController.signal,
          })
        : (undefined as inferRouterContext<TRouter>);
      if (this.#isClosed()) {
        return;
      }
      await this.#writer.send(
        {
          protocol: TRPC_WEBRTC_PROTOCOL,
          type: 'ready',
        },
        'control',
      );
      if (this.#handshakeTimer !== undefined) {
        clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = undefined;
      }
      this.#state = 'ready';
      this.#heartbeat.start();
      this.#readyDeferred.resolve();
    } catch (cause) {
      if (this.#isClosed()) {
        return;
      }
      const error = getTRPCErrorFromUnknown(cause);
      this.#notifyError(error, 'unknown', undefined, undefined);
      await this.#sendError(null, error, 'unknown', undefined, undefined).catch(() => undefined);
      this.close({ closeChannel: true, reason: error });
    }
  }

  #handleRequest(request: WebRTCRequestFrame): void {
    const existing = this.#active.get(request.id);
    if (existing) {
      const protocolError = new WebRTCProtocolError(`Duplicate request id ${request.id}`);
      existing.controller.abort(protocolError);
      this.#writer.cancelKey(request.id, protocolError);
      const error = new TRPCError({
        code: 'BAD_REQUEST',
        message: `Duplicate request id ${request.id}`,
      });
      this.#notifyError(error, request.procedureType, request.path, request.input);
      this.#sendRequestError(request, error);
      return;
    }
    if (this.#active.size >= this.#maxConcurrentOperations) {
      const error = new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `This WebRTC connection allows at most ${this.#maxConcurrentOperations} concurrent operations`,
      });
      this.#notifyError(error, request.procedureType, request.path, request.input);
      this.#sendRequestError(request, error);
      return;
    }
    const controller = new AbortController();
    this.#active.set(request.id, {
      controller,
      request,
    });
    void this.#execute(request, controller);
  }

  async #execute(request: WebRTCRequestFrame, controller: AbortController): Promise<void> {
    let input: unknown = request.input;
    try {
      input = getRouterTransformer(this.#router).input.deserialize(request.input);
      input = injectLastEventId(input, request.lastEventId);
      const result = await callTRPCProcedure({
        router: this.#router,
        path: request.path,
        getRawInput: async () => input,
        ctx: this.#ctx,
        type: request.procedureType,
        signal: controller.signal,
        batchIndex: 0,
      });
      if (controller.signal.aborted) {
        return;
      }

      if (request.procedureType !== 'subscription') {
        if (isAsyncIterable(result) || isObservable(result)) {
          throw new TRPCError({
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: `Cannot return an async iterable or observable from a ${request.procedureType} procedure`,
          });
        }
        const data = getRouterTransformer(this.#router).output.serialize(result);
        await this.#writer.send(
          {
            protocol: TRPC_WEBRTC_PROTOCOL,
            type: 'result',
            id: request.id,
            result: 'value',
            ...(data === undefined ? {} : { data }),
          },
          request.id,
        );
        if (!controller.signal.aborted) {
          await this.#sendComplete(request.id);
        }
        return;
      }

      const iterable = isObservable(result)
        ? observableToAsyncIterable(result, controller.signal)
        : result;
      if (!isAsyncIterable(iterable)) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Subscription ${request.path} did not return an async iterable`,
        });
      }

      await this.#writer.send(
        {
          protocol: TRPC_WEBRTC_PROTOCOL,
          type: 'result',
          id: request.id,
          result: 'started',
        },
        request.id,
      );

      const iterator = iterable[Symbol.asyncIterator]();
      try {
        while (!controller.signal.aborted) {
          const next = await nextWithAbort(iterator, controller.signal);
          if (next === 'aborted' || next.done) {
            break;
          }
          let output = next.value;
          let eventId: string | undefined;
          if (isTrackedEnvelope(output)) {
            const [id, data] = output;
            eventId = id;
            output = {
              id,
              data,
            };
          }
          const data = getRouterTransformer(this.#router).output.serialize(output);
          await this.#writer.send(
            {
              protocol: TRPC_WEBRTC_PROTOCOL,
              type: 'data',
              id: request.id,
              ...(data === undefined ? {} : { data }),
              ...(eventId ? { eventId } : {}),
            },
            request.id,
          );
        }
      } finally {
        if (controller.signal.aborted) {
          await Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
      }
      if (!controller.signal.aborted) {
        await this.#sendComplete(request.id);
      }
    } catch (cause) {
      if (!controller.signal.aborted && this.#state === 'ready') {
        const error = getTRPCErrorFromUnknown(cause);
        this.#notifyError(error, request.procedureType, request.path, input);
        try {
          await this.#sendError(request.id, error, request.procedureType, request.path, input);
        } catch (sendCause) {
          this.close({
            closeChannel: true,
            reason: sendCause instanceof Error ? sendCause : new Error(String(sendCause)),
          });
        }
      }
    } finally {
      this.#active.delete(request.id);
    }
  }

  async #sendComplete(id: WebRTCRequestId): Promise<void> {
    await this.#writer.send(
      {
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'complete',
        id,
      },
      id,
    );
  }

  #sendRequestError(request: WebRTCRequestFrame, error: TRPCError): void {
    void this.#sendError(
      request.id,
      error,
      request.procedureType,
      request.path,
      request.input,
    ).catch((cause: unknown) => {
      this.close({
        closeChannel: true,
        reason: cause instanceof Error ? cause : new Error(String(cause)),
      });
    });
  }

  async #sendError(
    id: WebRTCRequestId | null,
    error: TRPCError,
    type: TRPCProcedureType | 'unknown',
    path: string | undefined,
    input: unknown,
  ): Promise<void> {
    const frame: WebRTCErrorFrame = {
      protocol: TRPC_WEBRTC_PROTOCOL,
      type: 'error',
      id,
      error: shapeRouterError({
        router: this.#router,
        error,
        type,
        path,
        input,
        ctx: this.#ctx,
      }),
    };
    await this.#writer.send(frame, id ?? 'control');
  }

  async #fatalProtocolError(message: string): Promise<void> {
    if (this.#state === 'closed') {
      return;
    }
    const protocolError = new WebRTCProtocolError(message);
    this.#notifyProtocolError(protocolError);
    const error = new TRPCError({
      code: 'PARSE_ERROR',
      message,
      cause: protocolError,
    });
    this.#notifyError(error, 'unknown', undefined, undefined);
    await this.#sendError(null, error, 'unknown', undefined, undefined).catch(() => undefined);
    this.close({ closeChannel: true, reason: protocolError });
  }

  #notifyError(
    error: TRPCError,
    type: TRPCProcedureType | 'unknown',
    path: string | undefined,
    input: unknown,
  ): void {
    try {
      this.#options.onError?.({
        error,
        type,
        path,
        input,
        ctx: this.#ctx,
        channel: this.#channel,
        peer: this.#peer,
      });
    } catch {
      // User callbacks must not break transport event processing.
    }
  }

  #notifyProtocolError(error: WebRTCProtocolError): void {
    try {
      this.#options.onProtocolError?.(error);
    } catch {
      // User callbacks must not break transport event processing.
    }
  }

  #isClosed(): boolean {
    return this.#state === 'closed';
  }
}

function createCancellationError(reason: string | undefined): Error {
  const error = new Error(reason ?? 'The client cancelled the operation');
  error.name = 'AbortError';
  return error;
}

export function createWebRTCHandler<TRouter extends AnyTRPCRouter, TPeer = unknown>(
  options: CreateWebRTCHandlerOptions<TRouter, TPeer>,
): WebRTCHandler {
  return new WebRTCServerHandler(options);
}
