# @webrtc-node/trpc-webrtc-link

A tRPC v11 terminating client link and server handler for ordered, reliable
WebRTC `RTCDataChannel` connections.

The package transports concurrent queries, mutations, and subscriptions. It
supports cancellation, transformers, custom error formatting, `tracked()`
events, reconnect and subscription resumption, connection state, connection
parameters, keep-alive, frame limits, and fair backpressure.

SDP/ICE signaling remains application-owned: the package consumes data
channels but does not create peer connections or decide who a peer is.

## Requirements

- Node.js 20.19 or newer;
- TypeScript 5.7.2 or newer;
- matching `@trpc/client` and `@trpc/server` versions in the supported range
  `>=11.17.0 <11.19.0`;
- an ordered, reliable `RTCDataChannel`.

Install the transport and tRPC peers:

```sh
npm install @webrtc-node/trpc-webrtc-link @trpc/client @trpc/server
```

Node.js peers also need the current WebRTC implementation:

```sh
npm install @webrtc-node/webrtc
```

The transport never imports or bundles `@webrtc-node/webrtc`; browsers use
their native WebRTC APIs.

## Basic client

An existing channel negotiates immediately, even before the first tRPC
operation. Await `connect()` when application startup depends on readiness.

```ts
import { createTRPCClient } from '@trpc/client';
import { createWebRTCLink } from '@webrtc-node/trpc-webrtc-link';
import type { AppRouter } from './router';

const link = createWebRTCLink<AppRouter>({
  channel,
  connectionParams: {
    authorization: `Bearer ${accessToken}`,
  },
  keepAlive: {
    enabled: true,
    intervalMs: 5_000,
    pongTimeoutMs: 1_000,
  },
});

const client = createTRPCClient<AppRouter>({
  links: [link],
});

await link.connect();

const greeting = await client.greeting.query();
const count = await client.counter.increment.mutate();

const subscription = client.events.subscribe(undefined, {
  onData(event) {
    console.log(event);
  },
  onConnectionStateChange(state) {
    console.log(state.state); // idle, connecting, or pending
  },
});

subscription.unsubscribe();
link.close();
```

If the router has a transformer, provide the matching transformer to the link:

```ts
const link = createWebRTCLink<AppRouter>({
  channel,
  transformer: superjson,
});
```

The link is a standard tRPC terminating link. It composes with `loggerLink`,
`retryLink`, and `splitLink`, and works with vanilla tRPC, TanStack Query, and
the tRPC React integrations without package-specific bindings.

## Server handler

Create one handler for every server-side data channel. Context is created once
per channel and receives typed peer metadata, connection parameters, and a
signal that aborts when the channel or handler closes.

```ts
import { createWebRTCHandler } from '@webrtc-node/trpc-webrtc-link';
import { TRPCError } from '@trpc/server';

const handler = createWebRTCHandler({
  router: appRouter,
  channel,
  peer: {
    userId: authenticatedPeer.userId,
    peerConnection,
  },
  createContext({ peer, connectionParams, signal }) {
    if (connectionParams?.authorization !== expectedAuthorization) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    return {
      userId: peer.userId,
      signal,
    };
  },
  keepAlive: {
    enabled: true,
    intervalMs: 30_000,
    pongTimeoutMs: 5_000,
  },
  maxConcurrentOperations: 100,
  onError({ error, path }) {
    console.error(path, error);
  },
});

await handler.ready;

// Before rotating a peer connection or server:
await handler.requestReconnect('server rotation');

// During final cleanup:
handler.close({ closeChannel: true });
```

`close()` aborts procedures and subscription iterators, rejects queued writes,
and removes all listeners. The channel is only closed when
`closeChannel: true` is supplied.

## Signaling and reconnect

Use a channel factory when signaling can establish replacement peer
connections. The factory is called once per attempt and must return a fresh
channel. The remote application must attach a new `createWebRTCHandler()` to
the matching server channel.

```ts
const link = createWebRTCLink<AppRouter>({
  channel: async ({ signal, attempt, cause }) => {
    console.log({ attempt, cause });
    return signaling.createDataChannel({ signal });
  },
  reconnect: {
    enabled: true,
    maxAttempts: 8,
    retryDelayMs: (attempt) => (attempt === 0 ? 0 : Math.min(1_000 * 2 ** attempt, 30_000)),
    shouldRetry: ({ error }) => !isPermanentSignalingError(error),
  },
  connectionParams: () => ({
    authorization: `Bearer ${getCurrentAccessToken()}`,
  }),
});
```

Connection parameters are evaluated again for each attempt. The factory's
signal is aborted when an attempt times out, is replaced, or the link closes.

With automatic reconnect enabled:

- active subscriptions remain registered;
- their last delivered tracked event ID is sent to the new server;
- queries and mutations interrupted after transmission fail, allowing
  `retryLink` or the consuming framework to decide whether replay is safe;
- subscription observers receive tRPC connection states.

Automatic reconnect requires a factory. Without automatic reconnect, the same
factory is still reusable by `retryLink` or a later operation after a channel
failure.

Set `lazy: true` to delay a factory until `connect()` or the first operation.
Direct channels always negotiate immediately so a server handshake timeout
cannot close an otherwise idle connection.

The extended link exposes:

```ts
await link.connect();
await link.reconnect();

console.log(link.connectionState);

const unsubscribe = link.subscribeConnectionState((state) => {
  console.log(state);
});

unsubscribe();
link.close();
```

## Tracked subscriptions

The transport implements tRPC's complete `tracked()` contract. Clients receive
the inferred `{ id, data }` value, while the result-level ID is retained for
`retryLink` and channel replacement.

```ts
import { initTRPC, tracked } from '@trpc/server';
import { z } from 'zod';

const t = initTRPC.create();

const router = t.router({
  events: t.procedure
    .input(
      z
        .object({
          lastEventId: z.string().nullish(),
        })
        .optional(),
    )
    .subscription(async function* ({ input, signal }) {
      for await (const event of readEventsAfter(input?.lastEventId, signal)) {
        yield tracked(event.id, event);
      }
    }),
});
```

```ts
client.events.subscribe(undefined, {
  onData(event) {
    console.log(event.id, event.data);
  },
});
```

For operation-level errors, place tRPC's `retryLink` before this terminating
link. `retryLink` automatically injects the last known event ID into the next
subscription input.

## Cancellation and delivery

- Query and mutation `AbortSignal` cancellation sends a cancel frame.
- Subscription `unsubscribe()` sends a cancel frame.
- Every server procedure receives an operation-specific signal.
- Closing a channel aborts all server operations.

Cancellation is best effort if the channel disappears before the frame is
delivered. Mutations are not automatically replayed, and the package does not
claim exactly-once execution.

## Backpressure and limits

Both endpoints use `RTCDataChannel.bufferedAmount`. Writes pause above the high
watermark, resume after `bufferedamountlow`, and drain operation queues
round-robin so a busy subscription cannot starve other calls.

```ts
{
  backpressure: {
    highWatermark: 1024 * 1024,
    lowWatermark: 256 * 1024,
    queueLimit: 1024,
    maxMessageBytes: 1024 * 1024,
  },
}
```

Frames are never silently dropped. Queue overflow fails the affected operation
with `WebRTCQueueOverflowError`. Configure `maxMessageBytes` at or below the
effective SCTP message size used by both peers. Servers can additionally set
`maxConcurrentOperations`.

## Errors and lifecycle callbacks

Remote tRPC errors and transport failures surface as `TRPCClientError`.
Transport failures include:

```ts
error.meta?.transport === 'webrtc';
error.meta?.transportCode;
```

Transport codes distinguish channel closure, failed opening, handshake
timeout, keep-alive timeout, protocol errors, queue overflow, exhausted
reconnect attempts, and unreliable channels.

Client options include `onOpen`, `onClose`, `onError`,
`onConnectionStateChange`, and `onProtocolError`. Server options include
`onError` and `onProtocolError`. Exceptions thrown by lifecycle callbacks do
not break transport event processing.

## Protocol and security

The wire identifier is `trpc-webrtc/1`. It uses validated JSON text frames over
an ordered, reliable SCTP stream. See the
[protocol reference](https://github.com/webrtc-node/trpc-webrtc-link/blob/main/docs/protocol.md)
for frame details.

WebRTC encrypts transport traffic, but applications must still:

- authenticate and authorize signaling participants;
- protect SDP and ICE exchange against peer substitution;
- treat `peer` metadata as trusted only when signaling established it;
- validate every procedure input;
- use short-lived connection parameters where appropriate;
- set queue, message, and concurrency limits for untrusted peers.

## Deliberate non-goals

The package does not provide:

- SDP/ICE signaling or peer discovery;
- a specific authentication system;
- request batching (operations are already concurrently multiplexed);
- binary codecs;
- unrelated-protocol multiplexing;
- exactly-once delivery.

## Support

- [Runnable browser-to-Node example](https://github.com/webrtc-node/trpc-webrtc-link/tree/main/examples/basic)
- [Connection lifecycle guide](https://github.com/webrtc-node/trpc-webrtc-link/blob/main/docs/lifecycle.md)
- [Changelog](https://github.com/webrtc-node/trpc-webrtc-link/blob/main/docs/changelog.md)
- [Issues](https://github.com/webrtc-node/trpc-webrtc-link/issues)
- [Private vulnerability reports](https://github.com/webrtc-node/trpc-webrtc-link/security/advisories/new)
