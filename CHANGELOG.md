# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-11

### Fixed

- Close the server handler cleanly when an asynchronous control-frame reply
  fails instead of allowing an unhandled promise rejection.

### Added

- Failure-path coverage for channel factories, handshake timeouts, context
  creation, frame limits, native send errors, channel setup, and repeated
  cleanup.
- Enforced V8 source coverage thresholds with text, JSON, and LCOV reports.
- Automated Google Chrome browser-to-Node WebRTC coverage in CI.

## [0.1.0] - 2026-06-11

### Added

- A tRPC v11 terminating client link and server handler for established
  `RTCDataChannel` connections.
- Concurrent queries, mutations, subscriptions, cancellation, transformed
  payloads, protocol validation, and explicit channel cleanup.
- Versioned JSON framing with handshake, result, error, completion, cancellation,
  and ping/pong control frames.
- Bounded fair-write queuing with configurable RTC data channel backpressure.
- Browser and Node.js support without importing `@mertushka/webrtc-node` into
  browser builds.
- Unit, Node-to-Node integration, type inference, packed consumer, and browser
  example coverage.

[Unreleased]: https://github.com/mertushka/trpc-webrtc-link/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mertushka/trpc-webrtc-link/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mertushka/trpc-webrtc-link/releases/tag/v0.1.0
