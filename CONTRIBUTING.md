# Contributing

## Setup

Building requires Node.js 22.18 or newer. The browser end-to-end test also
requires Google Chrome Stable.

```sh
npm install
npm run check
```

The check command runs formatting, linting, type checking, unit tests, the real
Node WebRTC integration test, declaration tests, packed ESM/CommonJS/browser
consumer tests, package export and declaration validation with `publint` and
Are the Types Wrong, a real Chrome browser-to-Node WebRTC flow,
package/example builds, and an npm audit.

CI builds with Node.js 24, then installs and tests the resulting tarball on
Node.js 20.19, 22.18, and 24. Lower runtime targets do not execute `tsdown`.

## Pull requests

Create a branch from `main`, keep changes focused, and open a pull request.
Direct pushes to `main` are blocked. Required CI checks must pass before merge.

Update `CHANGELOG.md` for user-facing changes. Do not add secrets or private
connection metadata to issues, tests, logs, or examples.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
messages, for example `feat: add transport option` or
`fix: reject pending operations on close`.

Keep signaling, reconnection, and framework integrations outside the core
transport unless a change is required for protocol correctness.
