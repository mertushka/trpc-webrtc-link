import { setTimeout as delay } from 'node:timers/promises';
import {
  createTRPCClient,
  loggerLink,
  retryLink,
  splitLink,
  TRPCClientError,
  type TRPCClient,
} from '@trpc/client';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWebRTCHandler,
  createWebRTCLink,
  WebRTCKeepAliveTimeoutError,
  type WebRTCHandler,
  type WebRTCLink,
  type WebRTCLinkState,
} from '../src/index.js';
import { createInMemoryChannelPair, type InMemoryDataChannel } from './in-memory-channel.js';
import {
  createTestHarness,
  testRouter,
  type TestContext,
  type TestHarness,
  type TestRouter,
  type TestState,
  waitFor,
} from './test-utils.js';

function createState(): TestState {
  return {
    counter: 0,
    contextCreations: 0,
    subscriptionCancellations: 0,
    queryCancellations: 0,
    trackedInputs: [],
  };
}

function createContext(state: TestState): TestContext {
  state.contextCreations += 1;
  return {
    state,
    peerName: 'complete-test-peer',
  };
}

describe('complete tRPC transport behavior', () => {
  let harness: TestHarness | undefined;
  let link: WebRTCLink<TestRouter> | undefined;
  const handlers: WebRTCHandler[] = [];
  const channels: InMemoryDataChannel[] = [];

  afterEach(() => {
    harness?.close();
    link?.close();
    for (const handler of handlers.splice(0)) {
      handler.close();
    }
    for (const channel of channels.splice(0)) {
      channel.close();
    }
    harness = undefined;
    link = undefined;
    vi.restoreAllMocks();
  });

  it('converts tracked() envelopes to the runtime shape inferred by tRPC', async () => {
    harness = await createTestHarness();
    const values: Array<{
      id: string;
      data: { value: number; createdAt: Date };
    }> = [];

    await new Promise<void>((resolve, reject) => {
      harness!.client.trackedClock.subscribe(
        {
          count: 2,
          stayOpen: false,
        },
        {
          onData(value) {
            values.push(value);
          },
          onError: reject,
          onComplete: resolve,
        },
      );
    });

    expect(values).toEqual([
      {
        id: 'event-1',
        data: {
          value: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
      {
        id: 'event-2',
        data: {
          value: 2,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      },
    ]);
    expect(
      harness.serverChannel.sent
        .map((payload) => JSON.parse(payload) as { type?: string; eventId?: string })
        .filter((frame) => frame.type === 'data')
        .map((frame) => frame.eventId),
    ).toEqual(['event-1', 'event-2']);
  });

  it('integrates with retryLink and forwards the last tracked event id', async () => {
    const pair = createInMemoryChannelPair();
    const state = createState();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'retry-peer' },
      createContext() {
        return createContext(state);
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
    });
    const client = createTRPCClient<TestRouter>({
      links: [
        retryLink({
          retry({ op, attempts }) {
            return op.type === 'subscription' && attempts < 2;
          },
        }),
        link,
      ],
    });
    const values: Array<{ id: string; data: { value: number } }> = [];

    await new Promise<void>((resolve, reject) => {
      client.recoveringTracked.subscribe(undefined, {
        onData(value) {
          values.push(value);
        },
        onError: reject,
        onComplete: resolve,
      });
    });

    expect(values).toEqual([
      { id: 'event-1', data: { value: 1 } },
      { id: 'event-2', data: { value: 2 } },
    ]);
    expect(state.trackedInputs).toEqual([null, 'event-1']);
  });

  it('lets retryLink replace a failed channel for queries', async () => {
    const state = createState();
    const clientChannels: InMemoryDataChannel[] = [];
    const factory = vi.fn(() => {
      const pair = createInMemoryChannelPair();
      channels.push(pair.client, pair.server);
      clientChannels.push(pair.client);
      const handler = createWebRTCHandler({
        router: testRouter,
        channel: pair.server,
        peer: { name: 'query-retry-peer' },
        createContext() {
          return createContext(state);
        },
      });
      handlers.push(handler);
      return pair.client;
    });
    link = createWebRTCLink<TestRouter>({
      channel: factory,
      transformer: superjson,
    });
    const client = createTRPCClient<TestRouter>({
      links: [
        retryLink({
          retry({ op, attempts }) {
            return op.type === 'query' && attempts < 2;
          },
        }),
        link,
      ],
    });

    const result = client.delayed.query({ value: 42, waitMs: 30 });
    await waitFor(() =>
      clientChannels[0]!.sent.some((payload) => payload.includes('"path":"delayed"')),
    );
    clientChannels[0]!.close();

    await expect(result).resolves.toBe(42);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('composes as a terminating link with loggerLink and splitLink', async () => {
    const pair = createInMemoryChannelPair();
    const state = createState();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'composed-link-peer' },
      createContext() {
        return createContext(state);
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
    });
    const client = createTRPCClient<TestRouter>({
      links: [
        loggerLink({
          enabled: () => false,
        }),
        splitLink({
          condition: (operation) => operation.type === 'query',
          true: link,
          false: link,
        }),
      ],
    });

    await expect(client.hello.query({ name: 'composed' })).resolves.toBe(
      'hello composed from complete-test-peer',
    );
    await expect(client.counter.increment.mutate(2)).resolves.toBe(2);
  });

  it('negotiates a direct channel eagerly even when no operation is sent', async () => {
    const pair = createInMemoryChannelPair();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'idle-peer' },
      handshakeTimeoutMs: 20,
      createContext() {
        return createContext(createState());
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
    });

    await Promise.all([handler.ready, link.connect()]);
    await delay(30);

    expect(link.connectionState).toMatchObject({
      state: 'open',
    });
    expect(pair.client.readyState).toBe('open');
  });

  it('keeps a lazy channel factory dormant until connect is requested', async () => {
    let handler: WebRTCHandler | undefined;
    const factory = vi.fn(() => {
      const pair = createInMemoryChannelPair();
      channels.push(pair.client, pair.server);
      handler = createWebRTCHandler({
        router: testRouter,
        channel: pair.server,
        peer: { name: 'lazy-peer' },
        createContext() {
          return createContext(createState());
        },
      });
      handlers.push(handler);
      return pair.client;
    });
    link = createWebRTCLink<TestRouter>({
      channel: factory,
      transformer: superjson,
      lazy: true,
    });

    await delay(5);
    expect(factory).not.toHaveBeenCalled();

    await link.connect();
    await handler!.ready;
    expect(factory).toHaveBeenCalledOnce();
    expect(link.connectionState.state).toBe('open');
  });

  it('provides refreshed connection parameters to server context creation', async () => {
    const pair = createInMemoryChannelPair();
    const received = vi.fn();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'auth-peer' },
      createContext({ connectionParams }) {
        received(connectionParams);
        return createContext(createState());
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    const connectionParams = vi.fn(async () => ({
      authorization: 'Bearer test-token',
      session: 'session-1',
    }));
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
      connectionParams,
    });

    await Promise.all([link.connect(), handler.ready]);

    expect(connectionParams).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({
      authorization: 'Bearer test-token',
      session: 'session-1',
    });
  });

  it('reconnects subscriptions, reports state, and resumes from the last event', async () => {
    const state = createState();
    const linkStates: WebRTCLinkState[] = [];
    const factory = vi.fn(() => {
      const pair = createInMemoryChannelPair();
      channels.push(pair.client, pair.server);
      const handler = createWebRTCHandler({
        router: testRouter,
        channel: pair.server,
        peer: { name: 'reconnect-peer' },
        createContext() {
          return createContext(state);
        },
      });
      handlers.push(handler);
      return pair.client;
    });
    link = createWebRTCLink<TestRouter>({
      channel: factory,
      transformer: superjson,
      reconnect: {
        enabled: true,
        maxAttempts: 2,
        retryDelayMs: () => 0,
      },
      onConnectionStateChange(value) {
        linkStates.push(value);
      },
    });
    const client = createTRPCClient<TestRouter>({
      links: [link],
    });
    const values: Array<{ id: string; data: { value: number } }> = [];
    const subscriptionStates: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const subscription = client.trackedClock.subscribe(
        {
          count: 1,
          stayOpen: true,
        },
        {
          onData(value) {
            values.push(value);
            if (values.length === 1) {
              void handlers[0]!.requestReconnect('server rotation');
            } else {
              subscription.unsubscribe();
              resolve();
            }
          },
          onConnectionStateChange(value) {
            subscriptionStates.push(value.state);
          },
          onError: reject,
        },
      );
    });

    expect(values).toEqual([
      {
        id: 'event-1',
        data: {
          value: 1,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      },
      {
        id: 'event-2',
        data: {
          value: 2,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      },
    ]);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(state.trackedInputs).toEqual([null, 'event-1']);
    expect(linkStates.map((value) => value.state)).toContain('connecting');
    expect(linkStates.filter((value) => value.state === 'open')).toHaveLength(2);
    expect(subscriptionStates).toContain('connecting');
    expect(subscriptionStates.filter((value) => value === 'pending').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('supports explicit reconnects and removable lifecycle subscriptions', async () => {
    const state = createState();
    const factory = vi.fn(() => {
      const pair = createInMemoryChannelPair();
      channels.push(pair.client, pair.server);
      const handler = createWebRTCHandler({
        router: testRouter,
        channel: pair.server,
        peer: { name: 'manual-reconnect-peer' },
        createContext() {
          return createContext(state);
        },
      });
      handlers.push(handler);
      return pair.client;
    });
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    link = createWebRTCLink<TestRouter>({
      channel: factory,
      transformer: superjson,
      lazy: true,
      onOpen,
      onClose,
      onError,
    });
    const observed: string[] = [];
    const unsubscribe = link.subscribeConnectionState((value) => {
      observed.push(value.state);
    });

    await link.connect();
    await link.reconnect(new Error('rotate credentials'));
    unsubscribe();
    const observedBeforeClose = [...observed];
    link.close();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose.mock.calls[0]?.[0]).toMatchObject({
      willReconnect: true,
      error: {
        message: 'rotate credentials',
      },
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'rotate credentials',
      }),
    );
    expect(observed).toEqual(observedBeforeClose);
    expect(observed).toContain('idle');
    expect(observed.filter((value) => value === 'open')).toHaveLength(2);
  });

  it('surfaces reconnect exhaustion as a transport error', async () => {
    const factory = vi.fn(async () => {
      throw new Error('signaling unavailable');
    });
    link = createWebRTCLink<TestRouter>({
      channel: factory,
      transformer: superjson,
      lazy: true,
      reconnect: {
        enabled: true,
        maxAttempts: 1,
        retryDelayMs: () => 0,
      },
    });
    const client = createTRPCClient<TestRouter>({
      links: [link],
    });

    await expect(client.hello.query({ name: 'retry' })).rejects.toMatchObject({
      name: 'TRPCClientError',
      meta: {
        transport: 'webrtc',
        transportCode: 'RECONNECT_EXHAUSTED',
      },
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid reconnect delays without leaving the link connecting', async () => {
    const factory = vi.fn(async () => {
      throw new Error('first attempt failed');
    });
    link = createWebRTCLink<TestRouter>({
      channel: factory,
      transformer: superjson,
      lazy: true,
      reconnect: {
        enabled: true,
        maxAttempts: 2,
        retryDelayMs: () => -1,
      },
    });
    const client = createTRPCClient<TestRouter>({
      links: [link],
    });

    await expect(client.hello.query({ name: 'invalid-delay' })).rejects.toMatchObject({
      message: 'Reconnect delay must be a finite non-negative number',
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(link.connectionState).toMatchObject({
      state: 'idle',
      error: {
        message: 'Reconnect delay must be a finite non-negative number',
      },
    });
  });

  it('closes an unresponsive peer with client keep-alive', async () => {
    const pair = createInMemoryChannelPair();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'keepalive-peer' },
      createContext() {
        return createContext(createState());
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
      keepAlive: {
        enabled: true,
        intervalMs: 10,
        pongTimeoutMs: 10,
      },
    });
    await Promise.all([link.connect(), handler.ready]);
    const send = pair.server.send.bind(pair.server);
    vi.spyOn(pair.server, 'send').mockImplementation((payload) => {
      const frame = JSON.parse(payload) as { type?: string };
      if (frame.type !== 'pong') {
        send(payload);
      }
    });

    await waitFor(
      () =>
        link!.connectionState.state === 'idle' &&
        link!.connectionState.error instanceof WebRTCKeepAliveTimeoutError,
      1_000,
    );

    expect(pair.client.readyState).toBe('closed');
  });

  it('closes an unresponsive peer with server keep-alive', async () => {
    const pair = createInMemoryChannelPair();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'server-keepalive-peer' },
      keepAlive: {
        enabled: true,
        intervalMs: 10,
        pongTimeoutMs: 10,
      },
      createContext() {
        return createContext(createState());
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
    });
    await Promise.all([link.connect(), handler.ready]);
    const send = pair.client.send.bind(pair.client);
    vi.spyOn(pair.client, 'send').mockImplementation((payload) => {
      const frame = JSON.parse(payload) as { type?: string };
      if (frame.type !== 'pong') {
        send(payload);
      }
    });

    await waitFor(() => pair.server.readyState === 'closed', 1_000);
    expect(pair.client.readyState).toBe('closed');
  });

  it('limits concurrent operations without closing the connection', async () => {
    const pair = createInMemoryChannelPair();
    const state = createState();
    const handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'limited-peer' },
      maxConcurrentOperations: 1,
      createContext() {
        return createContext(state);
      },
    });
    handlers.push(handler);
    channels.push(pair.client, pair.server);
    link = createWebRTCLink<TestRouter>({
      channel: pair.client,
      transformer: superjson,
    });
    const client: TRPCClient<TestRouter> = createTRPCClient<TestRouter>({
      links: [link],
    });
    const controller = new AbortController();
    const first = client.never.query(undefined, {
      signal: controller.signal,
    });
    await waitFor(() => pair.client.sent.some((payload) => payload.includes('"path":"never"')));

    const error = await client.hello.query({ name: 'second' }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toMatchObject({
      data: {
        code: 'TOO_MANY_REQUESTS',
      },
    });
    await expect(client.counter.increment.mutate()).rejects.toMatchObject({
      data: {
        code: 'TOO_MANY_REQUESTS',
      },
    });
    controller.abort(new Error('test complete'));
    await expect(first).rejects.toMatchObject({
      message: 'test complete',
    });
    await waitFor(() => state.queryCancellations === 1);
    await expect(client.hello.query({ name: 'after' })).resolves.toBe(
      'hello after from complete-test-peer',
    );
  });
});
