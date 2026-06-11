# Contributing

## Setup

```sh
npm install
npm run check
```

The check command runs formatting, linting, type checking, unit tests, the real
Node WebRTC integration test, declaration tests, packed ESM/CommonJS/browser
consumer tests, package/example builds, and an npm audit.

Keep signaling, reconnection, and framework integrations outside the core
transport unless a change is required for protocol correctness.
