# @mertushka/trpc-webrtc-link

A tRPC v11 terminating client link and server adapter that transport queries,
mutations, and subscriptions over an already established `RTCDataChannel`.

This package handles tRPC framing, execution, cancellation, error shaping, and
backpressure. It does **not** perform SDP/ICE signaling, peer discovery,
reconnection, or authentication.

## Requirements

- Node.js 20 or newer;
- TypeScript 5.7.2 or newer;
- matching tRPC v11 `@trpc/client` and `@trpc/server` versions;
- an ordered, reliable `RTCDataChannel`.

## Installation

```sh
npm install @mertushka/trpc-webrtc-link @trpc/client @trpc/server
```

For Node WebRTC peers:

```sh
npm install @mertushka/webrtc-node
```

`@mertushka/webrtc-node` is not imported or bundled by this package. Browser
applications use the browser's native `RTCPeerConnection` and
`RTCDataChannel`.

## Client

Pass an open channel or an async factory. The factory is evaluated lazily on
the first tRPC operation.

```ts
import { createTRPCClient } from '@trpc/client';
import { createWebRTCLink } from '@mertushka/trpc-webrtc-link';
import type { AppRouter } from './server';

const link = createWebRTCLink<AppRouter>({
  channel: () => connectedDataChannel,
  backpressure: {
    highWatermark: 1024 * 1024,
    lowWatermark: 256 * 1024,
    queueLimit: 1024,
  },
});

const client = createTRPCClient<AppRouter>({
  links: [link],
});

const greeting = await client.hello.query();
const count = await client.counter.increment.mutate();

const subscription = client.clock.subscribe(undefined, {
  onData(value) {
    console.log(value);
  },
});

subscription.unsubscribe(); // sends cancellation to the server
link.close(); // rejects pending operations and removes listeners
```

When the router uses a transformer, pass the same transformer to the link:

```ts
const link = createWebRTCLink<AppRouter>({
  channel,
  transformer: superjson,
});
```

The link returns remote tRPC errors and transport failures as
`TRPCClientError`. Transport failures include `meta.transport === "webrtc"` and
may include a `meta.transportCode`.

## Server

The server adapter creates context once per attached channel. Context receives
the channel, typed application peer metadata, and a signal that aborts when the
handler or channel closes.

```ts
import { createWebRTCHandler } from '@mertushka/trpc-webrtc-link';
import { RTCPeerConnection } from '@mertushka/webrtc-node';
import { appRouter } from './router';

const peerConnection = new RTCPeerConnection();

peerConnection.addEventListener('datachannel', (event) => {
  const handler = createWebRTCHandler({
    router: appRouter,
    channel: event.channel,
    peer: {
      peerConnection,
      userId: 'user-123',
    },
    createContext({ channel, peer, signal }) {
      return {
        channel,
        userId: peer.userId,
        signal,
      };
    },
    onError({ error, path }) {
      console.error(path, error);
    },
  });

  void handler.ready;

  // Later:
  // handler.close({ closeChannel: true });
});
```

`close()` aborts active procedures, closes active subscription iterators,
rejects queued writes, and removes listeners. It leaves the underlying channel
open unless `closeChannel: true` is passed.

## Signaling

Signaling is an application responsibility. Exchange SDP descriptions and ICE
candidates using WebSocket, HTTP, QR codes, or another authenticated signaling
system. After the data channel opens, pass it to `createWebRTCLink` or
`createWebRTCHandler`.

The runnable [`examples/basic`](../../examples/basic) application uses a
WebSocket only for SDP/ICE. tRPC messages never pass through the signaling
server.

## Protocol

The exported protocol identifier is:

```ts
TRPC_WEBRTC_PROTOCOL === 'trpc-webrtc/1';
```

Version 1 uses JSON text frames:

| Frame           | Direction        | Purpose                               |
| --------------- | ---------------- | ------------------------------------- |
| `handshake`     | client to server | Negotiate `trpc-webrtc/1`             |
| `ready`         | server to client | Context exists and requests may start |
| `request`       | client to server | Query, mutation, or subscription      |
| `result`        | server to client | Unary value or subscription start     |
| `data`          | server to client | Subscription value                    |
| `error`         | server to client | Transformed tRPC error shape          |
| `complete`      | server to client | Normal operation completion           |
| `cancel`        | client to server | Abort a server operation              |
| `ping` / `pong` | either direction | Application heartbeat primitives      |

Every operation has an opaque collision-resistant string ID. The runtime
validates inbound frame shape, protocol version, IDs, and operation
transitions. Malformed or version-mismatched connection frames close the
channel. Unknown operation IDs and other correlatable state errors are reported
through `onProtocolError` without throwing from event listeners.

The protocol requires an ordered, reliable channel. Version 1 does not add
packet reordering or retransmission above SCTP.

## Cancellation

- An `AbortSignal` passed to a query or mutation sends `cancel`.
- Subscription `unsubscribe()` sends `cancel`.
- The server passes an operation-specific signal to tRPC procedures.
- Channel closure aborts all server operations and rejects all client
  operations.

Cancellation is best effort if the data channel closes before the cancel frame
is delivered. The package does not claim exactly-once execution.

## Backpressure

Both endpoints respect `RTCDataChannel.bufferedAmount`.

- Writes pause above `highWatermark`.
- The writer sets `bufferedAmountLowThreshold` and resumes after
  `bufferedamountlow`.
- Per-operation queues are drained round-robin so one subscription cannot
  indefinitely starve other calls.
- `queueLimit` bounds queued frame count.
- An enqueue above the limit fails with `WebRTCQueueOverflowError`.
- Frames are never silently dropped.

Defaults:

```ts
{
  highWatermark: 1024 * 1024,
  lowWatermark: 256 * 1024,
  queueLimit: 1024,
  maxMessageBytes: 1024 * 1024,
}
```

## tRPC compatibility

The package uses public tRPC v11 APIs for links, observables, procedure calls,
error shaping, and transformed responses.

One internal detail is unavoidable: the adapter reads
`router._def._config` to access the router's configured transformer and error
formatter. That access is isolated in `src/trpc-internals.ts`, matches tRPC's
own WebSocket adapter, and is covered by the `~11.17.0` peer range. New tRPC
minor versions must be reviewed and tested before widening that range.

## Security

- WebRTC encrypts the peer connection, but applications must authenticate and
  authorize signaling participants.
- Protect signaling messages against tampering and peer substitution.
- Validate all procedure input with tRPC validators.
- Treat `createContext` peer metadata as trusted only if the signaling layer
  established it securely.
- Configure queue and frame limits for the expected workload.
- Do not expose unrestricted procedures merely because the channel is
  peer-to-peer.

## Limitations

The first release intentionally does not include:

- SDP or ICE signaling;
- reconnection or subscription resumption;
- request batching;
- binary codecs;
- React bindings;
- peer discovery;
- multiplexing unrelated protocols;
- exactly-once delivery guarantees.

These are future-work candidates rather than implicit behavior.
