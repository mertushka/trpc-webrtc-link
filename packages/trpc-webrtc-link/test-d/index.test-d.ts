import { createTRPCClient } from '@trpc/client';
import { initTRPC, tracked } from '@trpc/server';
import { expectError, expectType } from 'tsd';
import { z } from 'zod';
import {
  createWebRTCHandler,
  createWebRTCLink,
  type RTCDataChannelLike,
} from '@webrtc-node/trpc-webrtc-link';

declare const channel: RTCDataChannelLike;

const t = initTRPC.context<{ peerId: string }>().create();

const appRouter = t.router({
  greeting: t.procedure.query(() => 'hello'),
  add: t.procedure.input(z.number()).mutation(({ input }) => input + 1),
  clock: t.procedure.subscription(async function* () {
    yield 1;
  }),
  trackedClock: t.procedure.subscription(async function* () {
    yield tracked('event-1', { value: 1 });
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
client.trackedClock.subscribe(undefined, {
  onData(value) {
    expectType<string>(value.id);
    expectType<number>(value.data.value);
  },
  onConnectionStateChange(value) {
    expectType<'idle' | 'connecting' | 'pending'>(value.state);
  },
});
expectType<Promise<void>>(link.connect());
expectType<Promise<void>>(link.reconnect());
expectType<'idle' | 'connecting' | 'open' | 'closed'>(link.connectionState.state);
expectType<() => void>(
  link.subscribeConnectionState((state) => {
    expectType<'idle' | 'connecting' | 'open' | 'closed'>(state.state);
  }),
);
link.close();

createWebRTCHandler({
  router: appRouter,
  channel,
  peer: { id: 'peer-1' },
  createContext({ channel: contextChannel, peer, connectionParams, signal }) {
    expectType<RTCDataChannelLike>(contextChannel);
    expectType<string>(peer.id);
    expectType<Record<string, string> | null>(connectionParams);
    expectType<AbortSignal>(signal);
    return {
      peerId: peer.id,
    };
  },
});

createWebRTCLink<typeof appRouter>({
  channel({ signal, attempt, cause }) {
    expectType<AbortSignal>(signal);
    expectType<number>(attempt);
    expectType<Error | null>(cause);
    return channel;
  },
  reconnect: {
    enabled: true,
    maxAttempts: 3,
    retryDelayMs(attempt, error) {
      expectType<number>(attempt);
      expectType<Error>(error);
      return 0;
    },
  },
  connectionParams: async () => ({
    authorization: 'Bearer token',
  }),
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
