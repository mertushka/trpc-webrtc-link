import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath;
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'trpc-webrtc-link-consumer-'));

assert.ok(npmCli, 'npm_execpath is required; run this test through npm');

function runNode(args, cwd) {
  execFileSync(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
    stdio: 'inherit',
  });
}

function readJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return readJavaScript(path);
      }

      return entry.name.endsWith('.js') ? [readFileSync(path, 'utf8')] : [];
    })
    .join('\n');
}

try {
  const packedOutput = execFileSync(
    process.execPath,
    [
      npmCli,
      'pack',
      '--json',
      '--pack-destination',
      temporaryDirectory,
      '--workspace',
      '@mertushka/trpc-webrtc-link',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const packedPackages = JSON.parse(packedOutput);

  assert.equal(packedPackages.length, 1);

  const tarball = join(temporaryDirectory, packedPackages[0].filename);
  const consumer = join(temporaryDirectory, 'consumer');
  const browserSource = join(consumer, 'browser');

  mkdirSync(browserSource, { recursive: true });
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'trpc-webrtc-link-packed-consumer',
        private: true,
        type: 'module',
        dependencies: {
          '@mertushka/trpc-webrtc-link': `file:${tarball}`,
          '@trpc/client': '11.17.0',
          '@trpc/server': '11.17.0',
        },
        devDependencies: {
          vite: '8.0.16',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(consumer, 'esm.mjs'),
    `
import assert from 'node:assert/strict';
import {
  TRPC_WEBRTC_PROTOCOL,
  createWebRTCHandler,
  createWebRTCLink,
} from '@mertushka/trpc-webrtc-link';

assert.equal(TRPC_WEBRTC_PROTOCOL, 'trpc-webrtc/1');
assert.equal(typeof createWebRTCHandler, 'function');
assert.equal(typeof createWebRTCLink, 'function');
`,
  );
  writeFileSync(
    join(consumer, 'commonjs.cjs'),
    `
const assert = require('node:assert/strict');
const {
  TRPC_WEBRTC_PROTOCOL,
  createWebRTCHandler,
  createWebRTCLink,
} = require('@mertushka/trpc-webrtc-link');

assert.equal(TRPC_WEBRTC_PROTOCOL, 'trpc-webrtc/1');
assert.equal(typeof createWebRTCHandler, 'function');
assert.equal(typeof createWebRTCLink, 'function');
`,
  );
  writeFileSync(
    join(browserSource, 'index.html'),
    '<div id="app"></div><script type="module" src="/main.js"></script>',
  );
  writeFileSync(
    join(browserSource, 'main.js'),
    `
import {
  TRPC_WEBRTC_PROTOCOL,
  createWebRTCLink,
} from '@mertushka/trpc-webrtc-link';

document.querySelector('#app').textContent =
  TRPC_WEBRTC_PROTOCOL + ':' + typeof createWebRTCLink;
`,
  );

  runNode([npmCli, 'install', '--package-lock=false'], consumer);
  runNode(['esm.mjs'], consumer);
  runNode(['commonjs.cjs'], consumer);
  runNode([npmCli, 'exec', '--', 'vite', 'build', 'browser', '--outDir', 'dist'], consumer);

  const browserBundle = readJavaScript(join(browserSource, 'dist'));

  assert.match(browserBundle, /trpc-webrtc\/1/);
  assert.doesNotMatch(browserBundle, /@mertushka\/webrtc-node/);
  assert.doesNotMatch(browserBundle, /node:/);

  console.log('Packed package consumers passed (ESM, CommonJS, browser).');
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
