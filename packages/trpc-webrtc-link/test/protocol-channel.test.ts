import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertReliableOrderedChannel,
  DataChannelWriter,
  normalizeBackpressureOptions,
  waitForDataChannelOpen,
} from '../src/channel.js';
import {
  parseWebRTCFrame,
  TRPC_WEBRTC_PROTOCOL,
  WebRTCChannelClosedError,
  WebRTCChannelNotOpenError,
  WebRTCQueueOverflowError,
  WebRTCUnreliableChannelError,
  type WebRTCDataFrame,
} from '../src/index.js';
import { createInMemoryChannelPair } from './in-memory-channel.js';
import { createTestHarness, type TestHarness, waitFor } from './test-utils.js';

describe('protocol validation', () => {
  let harness: TestHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it('rejects unsupported protocol versions', () => {
    expect(
      parseWebRTCFrame(
        JSON.stringify({
          protocol: 'trpc-webrtc/999',
          type: 'ping',
          nonce: 'test',
        }),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'unsupported_protocol',
        message: 'Unsupported protocol version: trpc-webrtc/999',
      },
    });
  });

  it.each([
    ['non-text data', new Uint8Array([1]), undefined, 'JSON text frames'],
    ['oversized data', '12345', 4, 'Frame exceeds the 4 byte limit'],
    ['invalid JSON', '{', undefined, 'not valid JSON'],
    ['non-object JSON', '[]', undefined, 'must be a JSON object'],
    [
      'missing frame type',
      JSON.stringify({ protocol: TRPC_WEBRTC_PROTOCOL }),
      undefined,
      'Frame type must be a string',
    ],
    [
      'invalid handshake role',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'handshake',
        role: 'server',
      }),
      undefined,
      'Handshake role must be "client"',
    ],
    [
      'invalid request id',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'request',
        id: '',
        procedureType: 'query',
        path: 'hello',
      }),
      undefined,
      'Request id is invalid',
    ],
    [
      'invalid procedure type',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'request',
        id: 'request',
        procedureType: 'stream',
        path: 'hello',
      }),
      undefined,
      'Request procedureType is invalid',
    ],
    [
      'invalid request path',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'request',
        id: 'request',
        procedureType: 'query',
        path: '',
      }),
      undefined,
      'Request path is invalid',
    ],
    [
      'invalid result kind',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'result',
        id: 'request',
        result: 'partial',
      }),
      undefined,
      'Result kind is invalid',
    ],
    [
      'missing error payload',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'error',
        id: null,
      }),
      undefined,
      'missing its error payload',
    ],
    [
      'oversized cancellation reason',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'cancel',
        id: 'request',
        reason: 'x'.repeat(1_025),
      }),
      undefined,
      'Cancel reason is invalid',
    ],
    [
      'empty ping nonce',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'ping',
        nonce: '',
      }),
      undefined,
      'Ping nonce is invalid',
    ],
    [
      'unknown frame type',
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'unknown',
      }),
      undefined,
      'Unknown frame type: unknown',
    ],
  ])('rejects %s', (_name, data, maxMessageBytes, message) => {
    const result = parseWebRTCFrame(data, maxMessageBytes);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'malformed_frame',
        message: expect.stringContaining(message),
      },
    });
  });

  it('reports unknown response ids without closing a healthy channel', async () => {
    const onProtocolError = vi.fn();
    harness = await createTestHarness({
      client: { onProtocolError },
    });

    harness.serverChannel.send(
      JSON.stringify({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'data',
        id: 'unknown',
        data: 1,
      }),
    );

    await waitFor(() => onProtocolError.mock.calls.length === 1);
    expect(harness.clientChannel.readyState).toBe('open');
  });

  it('aborts the original operation when a duplicate request id arrives', async () => {
    harness = await createTestHarness();
    const request = {
      protocol: TRPC_WEBRTC_PROTOCOL,
      type: 'request',
      id: 'duplicate',
      procedureType: 'query',
      path: 'never',
      input: superjson.serialize(undefined),
    } as const;

    harness.clientChannel.send(JSON.stringify(request));
    harness.clientChannel.send(JSON.stringify(request));

    await waitFor(() => harness!.state.queryCancellations === 1);
    await expect(harness.client.hello.query({ name: 'after-duplicate' })).resolves.toBe(
      'hello after-duplicate from test-peer',
    );
  });
});

describe('DataChannelWriter', () => {
  it.each([
    [{ highWatermark: -1 }, 'highWatermark'],
    [{ lowWatermark: -1 }, 'lowWatermark'],
    [{ highWatermark: 1, lowWatermark: 2 }, 'lowWatermark'],
    [{ queueLimit: 0 }, 'queueLimit'],
    [{ maxMessageBytes: 0 }, 'maxMessageBytes'],
  ])('rejects invalid backpressure options %j', (options, message) => {
    expect(() => normalizeBackpressureOptions(options)).toThrow(message);
  });

  it('drains operation queues in round-robin order', async () => {
    const { client } = createInMemoryChannelPair();
    client.autoDrain = false;
    const writer = new DataChannelWriter(client, {
      highWatermark: 0,
      lowWatermark: 0,
      queueLimit: 8,
    });
    const frame = (id: string): WebRTCDataFrame => ({
      protocol: TRPC_WEBRTC_PROTOCOL,
      type: 'data',
      id,
      data: id,
    });

    await writer.send(frame('blocker'), 'blocker');
    const writes = [
      writer.send(frame('a1'), 'a'),
      writer.send(frame('a2'), 'a'),
      writer.send(frame('b1'), 'b'),
    ];

    client.drain();
    await waitFor(() => client.sent.length === 2);
    client.drain();
    await waitFor(() => client.sent.length === 3);
    client.drain();
    await Promise.all(writes);

    expect(client.sent.map((payload) => (JSON.parse(payload) as WebRTCDataFrame).id)).toEqual([
      'blocker',
      'a1',
      'b1',
      'a2',
    ]);
    writer.close();
  });

  it('rejects rather than dropping frames when the queue is full', async () => {
    const { client } = createInMemoryChannelPair();
    client.autoDrain = false;
    const writer = new DataChannelWriter(client, {
      highWatermark: 0,
      lowWatermark: 0,
      queueLimit: 1,
    });
    const frame: WebRTCDataFrame = {
      protocol: TRPC_WEBRTC_PROTOCOL,
      type: 'data',
      id: 'frame',
      data: 1,
    };

    await writer.send(frame, 'blocker');
    const queued = writer.send({ ...frame, id: 'queued' }, 'queued');
    await expect(writer.send({ ...frame, id: 'overflow' }, 'overflow')).rejects.toBeInstanceOf(
      WebRTCQueueOverflowError,
    );
    client.drain();
    await queued;
    writer.close();
  });

  it('rejects non-serializable and oversized frames', async () => {
    const { client } = createInMemoryChannelPair();
    const writer = new DataChannelWriter(client, {
      maxMessageBytes: 64,
    });

    await expect(
      writer.send({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'data',
        id: 'bigint',
        data: 1n,
      }),
    ).rejects.toThrow('not JSON serializable');
    await expect(
      writer.send({
        protocol: TRPC_WEBRTC_PROTOCOL,
        type: 'data',
        id: 'oversized',
        data: 'x'.repeat(100),
      }),
    ).rejects.toThrow('exceeds the 64 byte limit');

    writer.close();
  });

  it('rejects the active and future writes when the channel send throws', async () => {
    const { client } = createInMemoryChannelPair();
    const writer = new DataChannelWriter(client);
    vi.spyOn(client, 'send').mockImplementationOnce(() => {
      throw new Error('native send failed');
    });
    const frame: WebRTCDataFrame = {
      protocol: TRPC_WEBRTC_PROTOCOL,
      type: 'data',
      id: 'send-error',
      data: 1,
    };

    await expect(writer.send(frame)).rejects.toMatchObject({
      name: 'WebRTCChannelNotOpenError',
      message: 'RTCDataChannel send failed',
      cause: expect.objectContaining({
        message: 'native send failed',
      }),
    });
    await expect(writer.send(frame)).rejects.toBeInstanceOf(WebRTCChannelNotOpenError);
    expect(client.listenerCount()).toBe(0);
    expect(client.bufferedAmountLowThreshold).toBe(0);
  });
});

describe('RTCDataChannel setup', () => {
  it('waits for a connecting channel and removes temporary listeners', async () => {
    const { client } = createInMemoryChannelPair();
    client.readyState = 'connecting';

    const opening = waitForDataChannelOpen(client, 100);
    expect(client.listenerCount()).toBe(3);
    client.readyState = 'open';
    client.dispatch('open', { type: 'open' });

    await opening;
    expect(client.listenerCount()).toBe(0);
  });

  it('rejects closed, errored, and timed-out channels without leaking listeners', async () => {
    const closed = createInMemoryChannelPair().client;
    closed.readyState = 'closed';
    await expect(waitForDataChannelOpen(closed, 10)).rejects.toBeInstanceOf(
      WebRTCChannelClosedError,
    );

    const errored = createInMemoryChannelPair().client;
    errored.readyState = 'connecting';
    const errorResult = waitForDataChannelOpen(errored, 100);
    errored.dispatch('error', new Error('open failed'));
    await expect(errorResult).rejects.toBeInstanceOf(WebRTCChannelNotOpenError);
    expect(errored.listenerCount()).toBe(0);

    const timedOut = createInMemoryChannelPair().client;
    timedOut.readyState = 'connecting';
    await expect(waitForDataChannelOpen(timedOut, 5)).rejects.toMatchObject({
      message: 'RTCDataChannel did not open within 5ms',
    });
    expect(timedOut.listenerCount()).toBe(0);
  });

  it('rejects unordered and partially reliable channels', () => {
    const unordered = createInMemoryChannelPair().client;
    Object.defineProperty(unordered, 'ordered', { value: false });
    expect(() => assertReliableOrderedChannel(unordered)).toThrow(WebRTCUnreliableChannelError);

    const limitedRetransmits = createInMemoryChannelPair().client;
    Object.defineProperty(limitedRetransmits, 'maxRetransmits', { value: 1 });
    expect(() => assertReliableOrderedChannel(limitedRetransmits)).toThrow(
      WebRTCUnreliableChannelError,
    );
  });
});
