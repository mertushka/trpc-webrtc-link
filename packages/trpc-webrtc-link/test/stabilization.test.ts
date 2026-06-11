import { createTRPCClient, TRPCClientError, type TRPCClient } from '@trpc/client';
import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWebRTCHandler,
  createWebRTCLink,
  TRPC_WEBRTC_PROTOCOL,
  type CreateWebRTCLinkOptions,
  type WebRTCHandler,
  type WebRTCLink,
} from '../src/index.js';
import { createInMemoryChannelPair } from './in-memory-channel.js';
import {
  createTestHarness,
  testRouter,
  type TestHarness,
  type TestRouter,
  waitFor,
} from './test-utils.js';

function createClient(options: CreateWebRTCLinkOptions<TestRouter>): {
  client: TRPCClient<TestRouter>;
  link: WebRTCLink<TestRouter>;
} {
  const link = createWebRTCLink<TestRouter>(options);
  return {
    client: createTRPCClient<TestRouter>({
      links: [link],
    }),
    link,
  };
}

describe('transport failure paths', () => {
  let harness: TestHarness | undefined;
  let link: WebRTCLink<TestRouter> | undefined;
  let handler: WebRTCHandler | undefined;

  afterEach(() => {
    harness?.close();
    link?.close();
    handler?.close();
    harness = undefined;
    link = undefined;
    handler = undefined;
  });

  it('rejects concurrent operations when the channel factory fails', async () => {
    const factoryError = new Error('channel factory failed');
    const channelFactory = vi.fn(async () => {
      throw factoryError;
    });
    const created = createClient({
      channel: channelFactory,
      transformer: superjson,
    });
    link = created.link;

    const results = await Promise.allSettled([
      created.client.hello.query({ name: 'first' }),
      created.client.hello.query({ name: 'second' }),
    ]);

    expect(channelFactory).toHaveBeenCalledOnce();
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(TRPCClientError);
        expect(result.reason).toMatchObject({
          message: 'channel factory failed',
          meta: {
            transport: 'webrtc',
            protocol: TRPC_WEBRTC_PROTOCOL,
          },
        });
      }
    }
  });

  it('rejects operations and removes listeners after a handshake timeout', async () => {
    const pair = createInMemoryChannelPair();
    const created = createClient({
      channel: pair.client,
      transformer: superjson,
      handshakeTimeoutMs: 20,
    });
    link = created.link;

    await expect(created.client.hello.query({ name: 'timeout' })).rejects.toMatchObject({
      name: 'TRPCClientError',
      meta: {
        transport: 'webrtc',
        transportCode: 'HANDSHAKE_TIMEOUT',
      },
    });
    expect(pair.client.listenerCount()).toBe(0);
    expect(pair.client.bufferedAmountLowThreshold).toBe(0);
  });

  it('closes the channel and rejects readiness when context creation fails', async () => {
    const pair = createInMemoryChannelPair();
    const onError = vi.fn();
    handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'test-peer' },
      createContext() {
        throw new Error('context creation failed');
      },
      onError,
    });
    const created = createClient({
      channel: pair.client,
      transformer: superjson,
    });
    link = created.link;

    const request = created.client.hello.query({ name: 'context' });

    await expect(handler.ready).rejects.toMatchObject({
      message: 'context creation failed',
    });
    await expect(request).rejects.toBeInstanceOf(TRPCClientError);
    await waitFor(() => pair.client.readyState === 'closed');
    expect(onError).toHaveBeenCalledOnce();
    expect(
      pair.server.sent.some((payload) => {
        const frame = JSON.parse(payload) as { type?: string; id?: string | null };
        return frame.type === 'error' && frame.id === null;
      }),
    ).toBe(true);
  });

  it('rejects an oversized outbound request without closing a healthy channel', async () => {
    harness = await createTestHarness({
      client: {
        backpressure: {
          maxMessageBytes: 512,
        },
      },
    });

    await expect(harness.client.hello.query({ name: 'x'.repeat(2_000) })).rejects.toMatchObject({
      name: 'TRPCClientError',
      message: 'WebRTC frame exceeds the 512 byte limit',
      meta: {
        transport: 'webrtc',
      },
    });
    expect(harness.clientChannel.readyState).toBe('open');
    await expect(harness.client.hello.query({ name: 'small' })).resolves.toBe(
      'hello small from test-peer',
    );
  });

  it('treats an oversized inbound frame as a fatal protocol error', async () => {
    const onProtocolError = vi.fn();
    harness = await createTestHarness({
      client: {
        backpressure: {
          maxMessageBytes: 512,
        },
        onProtocolError,
      },
    });

    harness.serverChannel.inject('x'.repeat(513));

    await waitFor(() => harness!.clientChannel.readyState === 'closed');
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Frame exceeds the 512 byte limit',
      }),
    );
  });

  it('converts RTCDataChannel send failures into client transport errors', async () => {
    harness = await createTestHarness();
    vi.spyOn(harness.clientChannel, 'send').mockImplementationOnce(() => {
      throw new Error('native send failed');
    });

    const error = await harness.client.hello.query({ name: 'send' }).catch((cause) => cause);

    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toMatchObject({
      message: 'RTCDataChannel send failed',
      meta: {
        transport: 'webrtc',
        transportCode: 'CHANNEL_NOT_OPEN',
      },
    });
    expect((error as TRPCClientError<TestRouter>).cause).toMatchObject({
      cause: expect.objectContaining({
        message: 'native send failed',
      }),
    });
  });

  it('closes the server cleanly when a control-frame reply cannot be sent', async () => {
    const pair = createInMemoryChannelPair();
    handler = createWebRTCHandler({
      router: testRouter,
      channel: pair.server,
      peer: { name: 'test-peer' },
      createContext() {
        return {
          state: {
            counter: 0,
            contextCreations: 1,
            subscriptionCancellations: 0,
            queryCancellations: 0,
          },
          peerName: 'test-peer',
        };
      },
    });
    pair.client.send(
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'handshake',
        role: 'client',
      }),
    );
    await handler.ready;
    vi.spyOn(pair.server, 'send').mockImplementationOnce(() => {
      throw new Error('pong send failed');
    });

    pair.client.send(
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'ping',
        nonce: 'health-check',
      }),
    );

    await waitFor(() => pair.client.readyState === 'closed');
    expect(pair.server.listenerCount()).toBe(0);
    expect(pair.server.bufferedAmountLowThreshold).toBe(0);
  });

  it('allows repeated client and server cleanup without side effects', async () => {
    harness = await createTestHarness();

    expect(() => {
      harness!.link.close();
      harness!.link.close();
      harness!.handler.close();
      harness!.handler.close();
    }).not.toThrow();

    expect(harness.clientChannel.listenerCount()).toBe(0);
    expect(harness.serverChannel.listenerCount()).toBe(0);
    expect(harness.clientChannel.bufferedAmountLowThreshold).toBe(0);
    expect(harness.serverChannel.bufferedAmountLowThreshold).toBe(0);
  });
});
