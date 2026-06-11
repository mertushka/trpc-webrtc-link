# @mertushka/trpc-webrtc-link

Transport tRPC v11 queries, mutations, and subscriptions over an established
WebRTC `RTCDataChannel`.

The package provides:

- a terminating tRPC client link;
- a server handler for tRPC routers;
- cancellation and concurrent operations;
- transformed inputs, outputs, and errors;
- bounded, fair backpressure handling;
- browser support using native WebRTC APIs;
- Node.js support through [`@mertushka/webrtc-node`](https://www.npmjs.com/package/@mertushka/webrtc-node).

It does not perform SDP or ICE signaling, peer discovery, authentication,
reconnection, or exactly-once delivery.

## Installation

```sh
npm install @mertushka/trpc-webrtc-link @trpc/client @trpc/server
```

Node.js peers also need:

```sh
npm install @mertushka/webrtc-node
```

## Documentation

- [Package guide](packages/trpc-webrtc-link)
- [Browser-to-Node example](examples/basic)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)

Signaling remains an application responsibility. Once an ordered, reliable
data channel is open, pass it to `createWebRTCLink()` on the client and
`createWebRTCHandler()` on the server.
