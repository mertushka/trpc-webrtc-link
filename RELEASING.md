# Releasing

Releases publish through npm Trusted Publishing from
`.github/workflows/publish.yml`. The workflow uses GitHub OIDC, contains no npm
token, and produces npm provenance.

## Prepare

1. Update the version in `packages/trpc-webrtc-link/package.json`.
2. Update the package version used by `examples/basic/package.json`.
3. Run `npm install --package-lock-only` to align `package-lock.json`.
4. Move the release notes from `Unreleased` into a dated section in
   `CHANGELOG.md`.
5. Run:

   ```sh
   npm ci
   npm run check
   npm pack --workspace @mertushka/trpc-webrtc-link --dry-run
   ```

6. Commit the release metadata with a Conventional Commit and merge it through
   a pull request.

## Publish

Create a GitHub release from the merged `main` commit with a tag matching the
package version:

```sh
gh release create v<version> \
  --target <commit> \
  --title "v<version>" \
  --notes-file <release-notes.md>
```

The publish workflow verifies the tag, runs the full check suite, and publishes
the package with public access.

## Verify

Confirm the registry version and provenance:

```sh
npm view @mertushka/trpc-webrtc-link version dist.attestations dist.integrity
```

If publishing fails after a version reaches npm, do not reuse that version.
Fix the issue and prepare a new patch release.
