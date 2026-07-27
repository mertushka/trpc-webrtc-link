# Contributing

## Setup

Building requires Node.js 22.18 or newer and the npm version declared by
`packageManager` in the root `package.json`. The browser end-to-end test also
requires Google Chrome Stable.

```sh
npm ci
npm run check
```

The check command runs formatting, linting, type checking, unit tests, the real
Node WebRTC integration test, declaration tests, packed ESM/CommonJS/browser
consumer tests, package export and declaration validation with `publint` and
Are the Types Wrong, a real Chrome browser-to-Node WebRTC flow,
package/example builds, and an npm audit.

Unit tests enforce source coverage thresholds of 82% statements, 77% branches,
87% functions, and 82% lines. Text coverage is printed during the test run;
JSON and LCOV reports are written to `packages/trpc-webrtc-link/coverage`.

CI builds with Node.js 24, then installs and tests the resulting tarball on
Node.js 20.19, 22.18, and 24. Lower runtime targets do not execute `tsdown`.

Run only the browser end-to-end flow with:

```sh
npm run test:e2e
```

## Architecture constraints

- Browser-facing package source must use the structural `RTCDataChannelLike`
  interface and must not import or bundle `@webrtc-node/webrtc`.
- The package prefers public tRPC APIs. The required
  `router._def._config` access is isolated in `src/trpc-internals.ts` and is the
  reason the peer dependency has a tested upper bound. Development tests use
  the newest supported tRPC release, while packed-consumer tests also exercise
  the minimum supported `11.17.0` release.
- Keep SDP/ICE signaling, peer discovery, identity policy, and framework
  integrations outside the core transport. Reconnection belongs in the
  transport, but obtaining each replacement channel remains a signaling
  factory responsibility.
- Tracked subscriptions must match tRPC's `{ id, data }` runtime contract and
  preserve the result-level event ID across retry and reconnect.

## Pull requests

Create a branch from `main`, keep changes focused, and open a pull request.
Direct pushes to `main` are blocked. Required CI checks must pass before merge.

Update `docs/changelog.md` for user-facing changes. Do not add secrets or private
connection metadata to issues, tests, logs, or examples.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages, for example `feat: add transport option` or
`fix: reject pending operations on close`.
