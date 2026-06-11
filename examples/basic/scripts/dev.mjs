import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npmCommand, ['run', 'dev:server'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  }),
  spawn(npmCommand, ['run', 'dev:browser'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  }),
];

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(error);
    shutdown(1);
  });
  child.once('exit', (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal)) {
      shutdown(code ?? 1);
    }
  });
}

process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());
