import superjson from 'superjson';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataChannelWriter } from '../src/channel.js';
import {
  parseWebRTCFrame,
  TRPC_WEBRTC_PROTOCOL,
  WebRTCQueueOverflowError,
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
});
