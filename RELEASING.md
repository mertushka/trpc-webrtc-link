# Releasing

Releases use npm Trusted Publishing from `.github/workflows/publish.yml`. The
workflow runs on GitHub-hosted infrastructure with `id-token: write`, contains
no npm token, and receives automatic npm provenance.

## One-time bootstrap

npm requires a package to exist before a trusted publisher can be configured.
For the first version only:

1. Run the full release check:

   ```sh
   npm ci
   npm run check
   ```

2. Authenticate an npm account with write access and 2FA, then publish the
   package:

   ```sh
   npm login
   npm publish --workspace @mertushka/trpc-webrtc-link --access public
   ```

3. With npm 11.10 or newer, configure the GitHub Actions trusted publisher:

   ```sh
   npm trust github @mertushka/trpc-webrtc-link \
     --repo mertushka/trpc-webrtc-link \
     --file publish.yml \
     --allow-publish
   ```

   The same configuration can be entered on npmjs.com using:

   - organization or user: `mertushka`
   - repository: `trpc-webrtc-link`
   - workflow filename: `publish.yml`
   - allowed action: `npm publish`

4. In the npm package settings, set publishing access to require 2FA and
   disallow tokens.

## Subsequent releases

1. Update and commit the package version.
2. Create a GitHub release tagged `v<package-version>`.
3. The publish workflow verifies the tag, runs `npm run check`, and publishes
   through OIDC.

Trusted Publishing requires Node.js 22.14 or newer and npm 11.5.1 or newer.
The workflow uses Node.js 24 and the bundled modern npm CLI.
