# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A server-side handshake timeout covering protocol negotiation and asynchronous
  context creation.
- Explicit install-script approvals enforced by the repository's pinned npm
  version.

### Changed

- Migrated the Node.js integration and example to `@webrtc-node/webrtc`.
- Updated development dependencies and expanded the tested tRPC peer range to
  `>=11.17.0 <11.19.0`.
- Updated GitHub Actions to current versioned major releases and tightened
  workflow permissions, concurrency, and timeouts.

### Fixed

- Apply one client deadline across channel opening and protocol negotiation,
  preserve disposal errors during asynchronous channel creation, and clean up
  failed writes.
- Cancel queued server responses when operations abort, validate timeout
  options, and reject invalid subscription state transitions.
- Measure UTF-8 frame sizes correctly when `TextEncoder` is unavailable and
  avoid redundant writer pump scheduling.

### Security

- Refreshed the lockfile to resolve all reported dependency advisories.

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
- Browser and Node.js support without importing a Node WebRTC implementation
  into browser builds.
- Unit, Node-to-Node integration, type inference, packed consumer, and browser
  example coverage.

[Unreleased]: https://github.com/webrtc-node/trpc-webrtc-link/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/webrtc-node/trpc-webrtc-link/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/webrtc-node/trpc-webrtc-link/releases/tag/v0.1.0
