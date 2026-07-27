# @webrtc-node/trpc-webrtc-link

A complete tRPC v11 transport for ordered, reliable WebRTC data channels.

It provides a terminating client link and a server handler with:

- queries, mutations, subscriptions, and cancellation;
- tRPC transformers, custom error shapes, and typed context;
- `tracked()` event IDs with `retryLink` and reconnect resumption;
- reusable channel factories, connection state, lifecycle callbacks, and
  server-requested reconnects;
- client and server keep-alive;
- bounded fair backpressure, frame limits, and concurrent-operation limits;
- browser WebRTC and Node.js WebRTC through
  [`@webrtc-node/webrtc`](https://www.npmjs.com/package/@webrtc-node/webrtc).

Applications remain responsible for authenticated SDP/ICE signaling and for
creating a fresh data channel when a reconnecting factory is called.

## Install

```sh
npm install @webrtc-node/trpc-webrtc-link @trpc/client @trpc/server
```

Node.js WebRTC peers also install:

```sh
npm install @webrtc-node/webrtc
```

## Start

Pass the same established channel to `createWebRTCLink()` on the client and
`createWebRTCHandler()` beside the tRPC router:

```ts
const link = createWebRTCLink<AppRouter>({ channel });
const client = createTRPCClient<AppRouter>({ links: [link] });

createWebRTCHandler({
  router: appRouter,
  channel: peerChannel,
  peer: authenticatedPeer,
  createContext: ({ peer }) => ({ userId: peer.userId }),
});

await link.connect();
const greeting = await client.greeting.query();
```

See the [complete package guide](packages/trpc-webrtc-link), the
[connection lifecycle guide](docs/lifecycle.md), the
[wire protocol reference](docs/protocol.md), and the runnable
[browser-to-Node example](examples/basic).

Project history is in the [changelog](docs/changelog.md). Contributions and
security reports use the files under [`.github`](.github).
