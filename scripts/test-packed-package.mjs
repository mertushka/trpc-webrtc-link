import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath;
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'trpc-webrtc-link-consumer-'));
const arguments_ = process.argv.slice(2);
const runtimeOnly = arguments_.includes('--runtime-only');
const tarballArgumentIndex = arguments_.indexOf('--tarball');
const tarballArgument =
  tarballArgumentIndex === -1 ? undefined : arguments_[tarballArgumentIndex + 1];

if (tarballArgumentIndex !== -1 && !tarballArgument) {
  throw new Error('--tarball requires a path');
}

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

function runNpm(args, cwd) {
  if (npmCli) {
    runNode([npmCli, ...args], cwd);
    return;
  }

  const bundledNpmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

  if (existsSync(bundledNpmCli)) {
    runNode([bundledNpmCli, ...args], cwd);
    return;
  }

  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
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
  let tarball;

  if (tarballArgument) {
    tarball = resolve(root, tarballArgument);
  } else {
    assert.ok(npmCli, 'npm_execpath is required when creating the tarball');

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
    tarball = join(temporaryDirectory, packedPackages[0].filename);
  }

  const consumer = join(temporaryDirectory, 'consumer');
  const browserSource = join(consumer, 'browser');

  mkdirSync(runtimeOnly ? consumer : browserSource, { recursive: true });
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
        devDependencies: runtimeOnly
          ? undefined
          : {
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
  if (!runtimeOnly) {
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
  }

  runNpm(['install', '--package-lock=false'], consumer);
  runNode(['esm.mjs'], consumer);
  runNode(['commonjs.cjs'], consumer);

  if (!runtimeOnly) {
    runNpm(['exec', '--', 'vite', 'build', 'browser', '--outDir', 'dist'], consumer);

    const browserBundle = readJavaScript(join(browserSource, 'dist'));

    assert.match(browserBundle, /trpc-webrtc\/1/);
    assert.doesNotMatch(browserBundle, /@mertushka\/webrtc-node/);
    assert.doesNotMatch(browserBundle, /node:/);
  }

  console.log(
    runtimeOnly
      ? `Packed package runtime passed on Node.js ${process.version} (ESM, CommonJS).`
      : 'Packed package consumers passed (ESM, CommonJS, browser).',
  );
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
