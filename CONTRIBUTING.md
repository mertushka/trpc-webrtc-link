# Contributing

## Setup

Building requires Node.js 22.18 or newer.

```sh
npm install
npm run check
```

The check command runs formatting, linting, type checking, unit tests, the real
Node WebRTC integration test, declaration tests, packed ESM/CommonJS/browser
consumer tests, package/example builds, and an npm audit.

CI builds with Node.js 24, then installs and tests the resulting tarball on
Node.js 20.19, 22.18, and 24. Lower runtime targets do not execute `tsdown`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages, for example `feat: add transport option` or
`fix: reject pending operations on close`.

Keep signaling, reconnection, and framework integrations outside the core
transport unless a change is required for protocol correctness.
