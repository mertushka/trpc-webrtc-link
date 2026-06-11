# @mertushka/trpc-webrtc-link

An npm workspace containing:

- [`@mertushka/trpc-webrtc-link`](packages/trpc-webrtc-link), a tRPC v11
  terminating link and server adapter for established RTC data channels;
- [`examples/basic`](examples/basic), a browser-to-Node example with separate
  WebSocket signaling.

## Development

```sh
npm install
npm run check
```

Run the example:

```sh
npm run dev --workspace @mertushka/trpc-webrtc-link-example-basic
```

Then open <http://127.0.0.1:5173>.

The implementation plan and upstream API decisions are recorded in
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

Released changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

Release automation and the one-time npm Trusted Publishing bootstrap are
documented in [`RELEASING.md`](RELEASING.md).
