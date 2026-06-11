# Basic browser-to-Node example

This application uses:

- native `RTCPeerConnection` and `RTCDataChannel` in the browser;
- `@mertushka/webrtc-node` on the Node server;
- a WebSocket only for SDP and ICE signaling;
- `@mertushka/trpc-webrtc-link` after the data channel is open.

From the repository root:

```sh
npm install
npm run dev --workspace @mertushka/trpc-webrtc-link-example-basic
```

Open <http://127.0.0.1:5173>. The UI demonstrates:

- `hello.query()`;
- `counter.increment.mutate()`;
- `clock.subscribe()`;
- cancellation by unsubscribing from the clock.

The signaling server listens on `ws://127.0.0.1:8787`. It does not forward
tRPC messages and is intentionally separate from the transport package.

Run the automated Google Chrome flow from the repository root:

```sh
npm run test:e2e
```

The test starts the signaling server and Vite, then verifies queries, a
mutation, subscription values, and cancellation over a real browser
`RTCDataChannel`.
