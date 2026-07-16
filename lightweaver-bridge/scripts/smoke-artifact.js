'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dist = path.resolve(__dirname, '..', 'dist');

function findFiles(directory, depth = 0) {
  if (depth > 6 || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? findFiles(fullPath, depth + 1) : [fullPath];
  });
}

const candidates = findFiles(dist).filter((candidate) => {
  if (process.platform === 'darwin') {
    return candidate.endsWith(path.join('.app', 'Contents', 'MacOS', 'Lightweaver Bridge'));
  }
  if (process.platform === 'win32') return candidate.endsWith('Lightweaver Bridge.exe');
  return path.basename(candidate) === 'lightweaver-bridge';
});

if (candidates.length !== 1) {
  process.stderr.write(`Expected exactly one packaged Lightweaver Bridge executable in dist; found ${candidates.length}\n`);
  process.exit(1);
}

const result = spawnSync(candidates[0], ['--smoke-test'], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`Unable to run packaged smoke test: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
