# Implementation Plan

## Repository shape

- Use an npm workspace with the publishable package in
  `packages/trpc-webrtc-link` and a runnable application in `examples/basic`.
- Build the package as ESM and CommonJS with declarations.
- Keep `@trpc/client` and `@trpc/server` on the tested tRPC 11.17 patch line
  because the adapter has one isolated dependency on router internals.
- Use `@mertushka/webrtc-node` only in Node integration tests and the example
  server. The browser-facing package source must never import it.

## Public transport API

- Export `createWebRTCLink<TRouter>()`, returning a terminating tRPC link with
  an explicit `close()` method for listener and pending-operation cleanup.
- Export `createWebRTCHandler()` for binding a router to one established data
  channel. The returned handler exposes `ready` and `close()`.
- Program against an exported structural `RTCDataChannelLike` interface.
- Require an ordered, reliable channel because the first protocol version does
  not implement retransmission or packet reordering.
- Export option, context metadata, error-handler, backpressure, and protocol
  frame types without exposing internal transport classes.

## Protocol

- Define `TRPC_WEBRTC_PROTOCOL = "trpc-webrtc/1"`.
- Send JSON text frames with strict runtime validation:
  `handshake`, `ready`, `request`, `result`, `data`, `error`, `complete`,
  `cancel`, `ping`, and `pong`.
- Generate opaque collision-resistant request IDs with `crypto.randomUUID()`
  when available and a randomized monotonic fallback otherwise.
- Treat malformed or version-mismatched handshake/control traffic as a
  protocol error. Correlatable request errors remain operation-scoped.
- Reject duplicate request IDs and invalid operation transitions without
  throwing from event listeners.

## tRPC integration

- Implement the client as a terminating `TRPCLink` using tRPC observables.
- Serialize input and deserialize output with the configured tRPC transformer.
- Convert remote tRPC error shapes to `TRPCClientError`.
- Convert transport, queue, protocol, close, and abort failures to
  `TRPCClientError` with transport metadata.
- Use public `callTRPCProcedure`, `getTRPCErrorShape`,
  `getTRPCErrorFromUnknown`, and observable utilities on the server.
- Isolate the unavoidable `router._def._config` access in one module to obtain
  the router transformer and error formatter, matching tRPC's WebSocket
  adapter behavior.
- Create context once per attached channel and pass the channel, peer metadata,
  and channel-lifetime abort signal.

## Cancellation and lifecycle

- Send `cancel` when a client operation is aborted or unsubscribed.
- Give every server operation its own `AbortController`.
- Race subscription iteration with cancellation and call `return()` on the
  iterator during cleanup.
- Abort all operations and reject all pending client work when the channel
  closes.
- Remove every installed listener and restore the prior low-watermark setting
  during explicit cleanup.

## Backpressure

- Implement one writer shared by each endpoint.
- Pause sends when `bufferedAmount` exceeds the configurable high watermark and
  resume on `bufferedamountlow` at the low watermark.
- Maintain per-operation queues and drain one frame per operation in round-robin
  order.
- Bound the total queued frame count. Reject the enqueue that exceeds the
  configured limit with a typed queue-overflow error.
- Resolve an enqueue only after its frame is sent; never silently discard data.

## Verification

- Unit-test with a paired in-memory data-channel implementation.
- Integration-test a real Node-to-Node peer connection using
  `@mertushka/webrtc-node`.
- Cover concurrency, mutations, subscription lifecycle, unsubscribe,
  `AbortSignal`, transformed values, server errors, malformed frames, closure,
  backpressure, overflow, and listener cleanup.
- Add declaration-level inference tests for query, mutation, and subscription
  clients.
- Install the packed tarball into a clean consumer and verify ESM, CommonJS,
  and browser bundling without `@mertushka/webrtc-node`.
- Add deterministic timeouts and cleanup to every asynchronous test.
- Run formatting checks, ESLint, TypeScript, unit tests, integration tests,
  type tests, and the package build.
