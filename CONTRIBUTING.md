# Contributing

## Setup

```sh
npm install
npm run check
```

The check command runs formatting, linting, type checking, unit tests, the real
Node WebRTC integration test, declaration tests, packed ESM/CommonJS/browser
consumer tests, package/example builds, and an npm audit.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages, for example `feat: add transport option` or
`fix: reject pending operations on close`.

Keep signaling, reconnection, and framework integrations outside the core
transport unless a change is required for protocol correctness.
