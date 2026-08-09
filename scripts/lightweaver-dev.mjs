import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lightweaverRoot = fileURLToPath(new URL('../lightweaver/', import.meta.url));

export function resolveDevelopmentSteps(mode, extraArguments = []) {
  const extras = extraArguments.map(value => String(value));
  if (mode === 'preview') {
    return [{
      command: 'npm',
      args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
    }];
  }
  if (mode === 'focused') {
    return [{
      command: 'npm',
      args: [
        'exec', '--', 'playwright', 'test', '--project=chromium', '--workers=1',
        ...extras,
      ],
    }];
  }
  if (mode === 'checkpoint') {
    return [
      { command: 'npm', args: ['run', 'test:unit'] },
      { command: 'node', args: ['scripts/ensure-rollup-native.mjs'] },
      { command: 'npm', args: ['run', 'build'] },
    ];
  }
  if (mode === 'release') {
    return [{ command: 'npm', args: ['run', 'launch:check'] }];
  }
  throw new Error(
    'Choose preview, focused, checkpoint, or release. Example: '
      + 'node scripts/lightweaver-dev.mjs focused tests/card-control-drawer.spec.ts',
  );
}

export function runDevelopmentMode(mode, extraArguments = []) {
  for (const step of resolveDevelopmentSteps(mode, extraArguments)) {
    const result = spawnSync(step.command, step.args, {
      cwd: lightweaverRoot,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.signal) return 1;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function main() {
  const [mode = '', ...extraArguments] = process.argv.slice(2);
  try {
    process.exitCode = runDevelopmentMode(mode, extraArguments);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
