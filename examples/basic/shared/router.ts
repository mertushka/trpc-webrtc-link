import { setTimeout as delay } from 'node:timers/promises';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';

export interface AppContext {
  peerId: string;
}

const t = initTRPC.context<AppContext>().create();
let counter = 0;

export const appRouter = t.router({
  hello: t.procedure.query(({ ctx }) => `Hello from Node peer ${ctx.peerId}`),
  counter: t.router({
    increment: t.procedure.mutation(() => {
      counter += 1;
      return counter;
    }),
  }),
  clock: t.procedure
    .input(z.object({ intervalMs: z.number().min(100).max(10_000) }))
    .subscription(async function* ({ input, signal }) {
      while (!signal?.aborted) {
        yield new Date().toISOString();
        await delay(input.intervalMs, undefined, { signal });
      }
    }),
});

export type AppRouter = typeof appRouter;
