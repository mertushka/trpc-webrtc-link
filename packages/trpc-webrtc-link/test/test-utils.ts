import { setTimeout as delay } from 'node:timers/promises';
import { createTRPCClient, type TRPCClient } from '@trpc/client';
import { initTRPC, tracked, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import superjson from 'superjson';
import { z } from 'zod';
import {
  createWebRTCHandler,
  createWebRTCLink,
  type CreateWebRTCLinkOptions,
  type WebRTCHandler,
} from '../src/index.js';
import { createInMemoryChannelPair, type InMemoryDataChannel } from './in-memory-channel.js';

export interface TestState {
  counter: number;
  contextCreations: number;
  subscriptionCancellations: number;
  queryCancellations: number;
  trackedInputs: Array<string | null>;
}

export interface TestContext {
  state: TestState;
  peerName: string;
}

const t = initTRPC.context<TestContext>().create({
  transformer: superjson,
  errorFormatter({ shape }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        transport: 'webrtc-test' as const,
      },
    };
  },
});

export const testRouter = t.router({
  hello: t.procedure
    .input(z.object({ name: z.string() }))
    .query(({ input, ctx }) => `hello ${input.name} from ${ctx.peerName}`),
  delayed: t.procedure
    .input(z.object({ value: z.number(), waitMs: z.number() }))
    .query(async ({ input }) => {
      await delay(input.waitMs);
      return input.value;
    }),
  counter: t.router({
    increment: t.procedure.input(z.number().default(1)).mutation(({ input, ctx }) => {
      ctx.state.counter += input;
      return ctx.state.counter;
    }),
  }),
  transformed: t.procedure.query(() => ({
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    values: new Set([1, 2, 3]),
  })),
  fail: t.procedure.query(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'not allowed',
    });
  }),
  never: t.procedure.query(async ({ signal, ctx }) => {
    await new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        ctx.state.queryCancellations += 1;
        reject(signal?.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  }),
  clock: t.procedure
    .input(z.object({ count: z.number().min(1), waitMs: z.number().default(0) }))
    .subscription(async function* ({ input, signal, ctx }) {
      try {
        for (let index = 0; index < input.count; index += 1) {
          if (signal?.aborted) {
            return;
          }
          yield index;
          if (input.waitMs > 0) {
            await delay(input.waitMs, undefined, { signal });
          }
        }
      } finally {
        if (signal?.aborted) {
          ctx.state.subscriptionCancellations += 1;
        }
      }
    }),
  observableClock: t.procedure
    .input(z.object({ count: z.number().int().min(1) }))
    .subscription(({ input }) =>
      observable<number>((observer) => {
        let stopped = false;
        let value = 0;
        const emit = () => {
          if (stopped) {
            return;
          }
          if (value >= input.count) {
            observer.complete();
            return;
          }
          observer.next(value);
          value += 1;
          queueMicrotask(emit);
        };
        queueMicrotask(emit);
        return () => {
          stopped = true;
        };
      }),
    ),
  trackedClock: t.procedure
    .input(
      z.object({
        count: z.number().int().min(1).default(1),
        stayOpen: z.boolean().default(false),
        lastEventId: z.string().nullish(),
      }),
    )
    .subscription(async function* ({ input, signal, ctx }) {
      ctx.state.trackedInputs.push(input.lastEventId ?? null);
      const previous = input.lastEventId?.match(/^event-(\d+)$/)?.[1];
      const start = previous ? Number(previous) + 1 : 1;
      for (let index = start; index < start + input.count; index += 1) {
        yield tracked(`event-${index}`, {
          value: index,
          createdAt: new Date(`2026-01-${String(index).padStart(2, '0')}T00:00:00.000Z`),
        });
      }
      if (input.stayOpen) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    }),
  recoveringTracked: t.procedure
    .input(
      z
        .object({
          lastEventId: z.string().nullish(),
        })
        .optional(),
    )
    .subscription(async function* ({ input, ctx }) {
      ctx.state.trackedInputs.push(input?.lastEventId ?? null);
      if (!input?.lastEventId) {
        yield tracked('event-1', { value: 1 });
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'retry this subscription',
        });
      }
      yield tracked('event-2', { value: 2 });
    }),
});

export type TestRouter = typeof testRouter;

export interface TestHarness {
  client: TRPCClient<TestRouter>;
  link: ReturnType<typeof createWebRTCLink<TestRouter>>;
  handler: WebRTCHandler;
  clientChannel: InMemoryDataChannel;
  serverChannel: InMemoryDataChannel;
  state: TestState;
  close(): void;
}

export async function createTestHarness(
  options: {
    client?: Partial<CreateWebRTCLinkOptions<TestRouter>>;
    serverBackpressure?: CreateWebRTCLinkOptions<TestRouter>['backpressure'];
  } = {},
): Promise<TestHarness> {
  const pair = createInMemoryChannelPair();
  const state: TestState = {
    counter: 0,
    contextCreations: 0,
    subscriptionCancellations: 0,
    queryCancellations: 0,
    trackedInputs: [],
  };
  const handler = createWebRTCHandler({
    router: testRouter,
    channel: pair.server,
    peer: { name: 'test-peer' },
    ...(options.serverBackpressure ? { backpressure: options.serverBackpressure } : {}),
    createContext({ peer }) {
      state.contextCreations += 1;
      return {
        state,
        peerName: peer.name,
      };
    },
  });
  const link = createWebRTCLink<TestRouter>({
    channel: pair.client,
    transformer: superjson,
    ...options.client,
  });
  const client = createTRPCClient<TestRouter>({
    links: [link],
  });
  await Promise.race([
    Promise.all([handler.ready, client.hello.query({ name: 'setup' })]),
    delay(2_000).then(() => {
      throw new Error('Timed out waiting for test handler readiness');
    }),
  ]);
  pair.client.sent.length = 0;
  pair.server.sent.length = 0;

  return {
    client,
    link,
    handler,
    clientChannel: pair.client,
    serverChannel: pair.server,
    state,
    close() {
      link.close();
      handler.close();
      pair.client.close();
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Condition was not met before timeout');
    }
    await delay(5);
  }
}
