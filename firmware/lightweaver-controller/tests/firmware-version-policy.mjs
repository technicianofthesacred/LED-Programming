import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const firmwareRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(firmwareRoot, '../..');
const versionPath = resolve(firmwareRoot, 'VERSION');
const helperPath = resolve(firmwareRoot, 'scripts/firmware-version.mjs');

const {
  bumpVersion,
  compareVersions,
  main,
  parseVersion,
} = await import(helperPath);

assert.equal(readFileSync(versionPath, 'utf8').trim(), '1.1.0');

assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
for (const malformed of ['', '1', '1.2', 'v1.2.3', '1.2.3-beta', '01.2.3', '1.02.3', '1.2.03']) {
  assert.throws(() => parseVersion(malformed), /strict semantic version/i, malformed);
}
assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
assert.equal(compareVersions('1.1.0', '1.1.0'), 0);
assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
assert.equal(bumpVersion('1.1.0', 'patch'), '1.1.1');
assert.equal(bumpVersion('1.1.0', 'minor'), '1.2.0');
assert.equal(bumpVersion('1.1.0', 'major'), '2.0.0');
assert.throws(() => bumpVersion('1.1.0', 'feature'), /patch, minor, or major/i);

const temp = mkdtempSync(join(tmpdir(), 'lightweaver-version-'));
try {
  const isolatedVersionPath = join(temp, 'VERSION');
  writeFileSync(isolatedVersionPath, '1.1.0\n');
  const output = [];
  assert.equal(main(['bump', 'patch'], {
    versionPath: isolatedVersionPath,
    write: value => output.push(value),
  }), '1.1.1');
  assert.equal(readFileSync(isolatedVersionPath, 'utf8'), '1.1.1\n');
  assert.deepEqual(output, ['1.1.1\n']);

  assert.equal(main(['check', '--previous', '1.1.0'], {
    versionPath: isolatedVersionPath,
    write: value => output.push(value),
  }), '1.1.1');
  assert.throws(
    () => main(['check', '--previous', '1.1.1'], { versionPath: isolatedVersionPath }),
    /must be greater than previous signed version/i,
  );
  assert.throws(
    () => main(['check', '--previous', '2.0.0'], { versionPath: isolatedVersionPath }),
    /must be greater than previous signed version/i,
  );
  writeFileSync(isolatedVersionPath, ' 1.1.1\n');
  assert.throws(
    () => main(['check', '--previous', '1.1.0'], { versionPath: isolatedVersionPath }),
    /strict semantic version/i,
    'canonical version files must not conceal whitespace with trimming',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const platformio = readFileSync(resolve(firmwareRoot, 'platformio.ini'), 'utf8');
const injector = readFileSync(resolve(firmwareRoot, 'scripts/inject-build-identity.py'), 'utf8');
const mainSource = readFileSync(resolve(firmwareRoot, 'src/main.cpp'), 'utf8');
const storageSource = readFileSync(resolve(firmwareRoot, 'src/LightweaverStorage.cpp'), 'utf8');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'lightweaver/package.json'), 'utf8'));

assert.doesNotMatch(
  platformio,
  /-DLW_FIRMWARE_VERSION=\\?"?(?:0|[1-9][0-9]*)\./,
  'PlatformIO must not duplicate the canonical version literal',
);
assert.match(injector, /VERSION/);
assert.match(injector, /LW_FIRMWARE_VERSION/);
assert.match(injector, /\(0\|\[1-9\]\[0-9\]\*\)/, 'injector must validate strict semantic versions');
assert.match(workflow, /firmware\/lightweaver-controller\/VERSION/);
assert.match(workflow, /firmware:version:check/);
assert.match(workflow, /--firmware-version "\$FW_VERSION"/);
assert.match(workflow, /firmware_version:/, 'tested compile and protected signer must share the resolved version');

for (const source of [mainSource, storageSource]) {
  assert.match(
    source,
    /Non-PlatformIO compile fallback only; PlatformIO injects canonical VERSION\.\n#ifndef LW_FIRMWARE_VERSION\n#define LW_FIRMWARE_VERSION "1\.0\.0"/,
  );
}

assert.equal(
  packageJson.scripts['firmware:bump'],
  'node ../firmware/lightweaver-controller/scripts/firmware-version.mjs bump',
);
assert.equal(
  packageJson.scripts['firmware:version:check'],
  'node ../firmware/lightweaver-controller/scripts/firmware-version.mjs check',
);
console.log('firmware version policy tests passed');
