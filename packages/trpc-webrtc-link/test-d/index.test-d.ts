import { createTRPCClient } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { expectError, expectType } from 'tsd';
import { z } from 'zod';
import {
  createWebRTCHandler,
  createWebRTCLink,
  type RTCDataChannelLike,
} from '@mertushka/trpc-webrtc-link';

declare const channel: RTCDataChannelLike;

const t = initTRPC.context<{ peerId: string }>().create();

const appRouter = t.router({
  greeting: t.procedure.query(() => 'hello'),
  add: t.procedure.input(z.number()).mutation(({ input }) => input + 1),
  clock: t.procedure.subscription(async function* () {
    yield 1;
  }),
});

const link = createWebRTCLink<typeof appRouter>({
  channel,
});
const client = createTRPCClient<typeof appRouter>({
  links: [link],
});

expectType<Promise<string>>(client.greeting.query());
expectType<Promise<number>>(client.add.mutate(1));
client.clock.subscribe(undefined, {
  onData(value) {
    expectType<number>(value);
  },
});
link.close();

createWebRTCHandler({
  router: appRouter,
  channel,
  peer: { id: 'peer-1' },
  createContext({ channel: contextChannel, peer, signal }) {
    expectType<RTCDataChannelLike>(contextChannel);
    expectType<string>(peer.id);
    expectType<AbortSignal>(signal);
    return {
      peerId: peer.id,
    };
  },
});

const transformedT = initTRPC.create({
  transformer: {
    serialize(value: unknown) {
      return value;
    },
    deserialize(value: unknown) {
      return value;
    },
  },
});
const _transformedRouter = transformedT.router({
  value: transformedT.procedure.query(() => new Date()),
});

expectError(
  createWebRTCLink<typeof _transformedRouter>({
    channel,
  }),
);
expectType<ReturnType<typeof createWebRTCLink<typeof _transformedRouter>>>(
  createWebRTCLink<typeof _transformedRouter>({
    channel,
    transformer: {
      serialize(value: unknown) {
        return value;
      },
      deserialize(value: unknown) {
        return value;
      },
    },
  }),
);
