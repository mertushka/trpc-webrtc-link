import { setTimeout as delay } from 'node:timers/promises';
import { TRPCClientError } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebRTCQueueOverflowError } from '../src/index.js';
import { createTestHarness, type TestHarness, waitFor } from './test-utils.js';

describe('WebRTC tRPC transport', () => {
  let harness: TestHarness | undefined;

  afterEach(() => {
    harness?.close();
    harness = undefined;
  });

  it('runs parallel queries and creates context once per channel', async () => {
    harness = await createTestHarness();

    const values = await Promise.all([
      harness.client.delayed.query({ value: 1, waitMs: 20 }),
      harness.client.delayed.query({ value: 2, waitMs: 0 }),
      harness.client.hello.query({ name: 'Ada' }),
    ]);

    expect(values).toEqual([1, 2, 'hello Ada from test-peer']);
    expect(harness.state.contextCreations).toBe(1);
  });

  it('runs mutations', async () => {
    harness = await createTestHarness();

    await expect(harness.client.counter.increment.mutate(2)).resolves.toBe(2);
    await expect(harness.client.counter.increment.mutate(3)).resolves.toBe(5);
  });

  it('streams subscription values and completes', async () => {
    harness = await createTestHarness();
    const values: number[] = [];
    const onStarted = vi.fn();
    const onStopped = vi.fn();

    await new Promise<void>((resolve, reject) => {
      harness!.client.clock.subscribe(
        { count: 3, waitMs: 1 },
        {
          onStarted,
          onData(value) {
            values.push(value);
          },
          onStopped,
          onError: reject,
          onComplete: resolve,
        },
      );
    });

    expect(values).toEqual([0, 1, 2]);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onStopped).toHaveBeenCalledOnce();
  });

  it('cancels a subscription when the client unsubscribes', async () => {
    harness = await createTestHarness();
    const values: number[] = [];

    const subscription = harness.client.clock.subscribe(
      { count: 100, waitMs: 5 },
      {
        onData(value) {
          values.push(value);
          if (values.length === 2) {
            subscription.unsubscribe();
          }
        },
      },
    );

    await waitFor(() => harness!.state.subscriptionCancellations === 1);
    expect(values).toEqual([0, 1]);
  });

  it('propagates AbortSignal cancellation to a running query', async () => {
    harness = await createTestHarness();
    const controller = new AbortController();
    const request = harness.client.never.query(undefined, {
      signal: controller.signal,
    });

    await delay(10);
    controller.abort(new Error('cancelled by test'));

    await expect(request).rejects.toMatchObject({
      name: 'TRPCClientError',
      message: 'cancelled by test',
    });
    await waitFor(() => harness!.state.queryCancellations === 1);
  });

  it('returns shaped server errors', async () => {
    harness = await createTestHarness();

    const error = await harness.client.fail.query().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect(error).toMatchObject({
      message: 'not allowed',
      data: {
        code: 'FORBIDDEN',
        httpStatus: 403,
        path: 'fail',
      },
    });
  });

  it('transforms inputs and outputs with the tRPC transformer', async () => {
    harness = await createTestHarness();

    const result = await harness.client.transformed.query();
    expect(result.createdAt).toEqual(new Date('2026-06-11T00:00:00.000Z'));
    expect(result.values).toEqual(new Set([1, 2, 3]));
  });

  it('rejects pending operations when the channel closes', async () => {
    harness = await createTestHarness();
    const request = harness.client.never.query();

    await delay(10);
    harness.clientChannel.close();

    await expect(request).rejects.toMatchObject({
      name: 'TRPCClientError',
      meta: {
        transport: 'webrtc',
        transportCode: 'CHANNEL_CLOSED',
      },
    });
  });

  it('treats malformed frames as fatal without throwing from listeners', async () => {
    const onProtocolError = vi.fn();
    harness = await createTestHarness({
      client: { onProtocolError },
    });

    expect(() => harness!.serverChannel.send('{not-json')).not.toThrow();
    await waitFor(() => harness!.clientChannel.readyState === 'closed');
    expect(onProtocolError).toHaveBeenCalled();
  });

  it('pauses above the high watermark and resumes without dropping requests', async () => {
    harness = await createTestHarness({
      client: {
        backpressure: {
          highWatermark: 0,
          lowWatermark: 0,
          queueLimit: 8,
        },
      },
    });
    harness.clientChannel.autoDrain = false;

    const first = harness.client.hello.query({ name: 'first' });
    await waitFor(() => harness!.clientChannel.bufferedAmount > 0);
    const second = harness.client.hello.query({ name: 'second' });

    await delay(20);
    expect(
      harness.clientChannel.sent.filter((value) => value.includes('"type":"request"')),
    ).toHaveLength(1);

    harness.clientChannel.drain();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'hello first from test-peer',
      'hello second from test-peer',
    ]);
  });

  it('fails the enqueue that exceeds the queue limit', async () => {
    harness = await createTestHarness({
      client: {
        backpressure: {
          highWatermark: 0,
          lowWatermark: 0,
          queueLimit: 1,
        },
      },
    });
    harness.clientChannel.autoDrain = false;

    const first = harness.client.delayed.query({ value: 1, waitMs: 20 });
    await waitFor(() => harness!.clientChannel.bufferedAmount > 0);
    const second = harness.client.delayed.query({ value: 2, waitMs: 20 });
    const third = harness.client.delayed.query({ value: 3, waitMs: 20 });

    const error = await third.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TRPCClientError);
    expect((error as TRPCClientError<any>).cause).toBeInstanceOf(WebRTCQueueOverflowError);

    harness.clientChannel.drain();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  });

  it('removes all transport listeners during explicit cleanup', async () => {
    harness = await createTestHarness();
    expect(harness.clientChannel.listenerCount()).toBeGreaterThan(0);
    expect(harness.serverChannel.listenerCount()).toBeGreaterThan(0);

    harness.link.close();
    harness.handler.close();

    expect(harness.clientChannel.listenerCount()).toBe(0);
    expect(harness.serverChannel.listenerCount()).toBe(0);
  });
});
