# Basic browser-to-Node example

This application uses:

- native `RTCPeerConnection` and `RTCDataChannel` in the browser;
- `@webrtc-node/webrtc` on the Node server;
- a WebSocket only for SDP and ICE signaling;
- `@webrtc-node/trpc-webrtc-link` after the data channel is open.
- connection parameters, explicit link readiness, and protocol keep-alive.

From the repository root:

```sh
npm install
npm run dev --workspace @webrtc-node/trpc-webrtc-link-example-basic
```

Open <http://127.0.0.1:5173>. The UI demonstrates:

- `hello.query()`;
- `counter.increment.mutate()`;
- `clock.subscribe()`;
- subscription connection-state updates;
- cancellation by unsubscribing from the clock.

The signaling server listens on `ws://127.0.0.1:8787`. It does not forward
tRPC messages and is intentionally separate from the transport package.
