import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const firmwareRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(firmwareRoot, '../..');
const versionPath = resolve(firmwareRoot, 'VERSION');
const helperPath = resolve(firmwareRoot, 'scripts/firmware-version.mjs');

const {
  bumpVersion,
  checkPreviousProduction,
  compareVersions,
  main,
  parseVersion,
} = await import(helperPath);

assert.equal(readFileSync(versionPath, 'utf8').trim(), '1.1.13');

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

const historyFixture = mkdtempSync(join(tmpdir(), 'lightweaver-version-history-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: historyFixture });
  execFileSync('git', ['config', 'user.name', 'Lightweaver CI'], { cwd: historyFixture });
  execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: historyFixture });
  const fixtureManifestPath = join(historyFixture, 'lightweaver/public/firmware/release-manifest.json');
  const fixtureVersionPath = join(historyFixture, 'VERSION');
  mkdirSync(join(historyFixture, 'lightweaver/public/firmware'), { recursive: true });
  const fixtureKeys = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const trustedManifest = '{"firmwareVersion":"2.0.0"}';
  const trustedSignature = sign('sha256', Buffer.from(trustedManifest), {
    key: fixtureKeys.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  writeFileSync(fixtureManifestPath, '{"firmwareVersion":"1.0.0"}\n');
  writeFileSync(fixtureVersionPath, '1.0.0\n');
  execFileSync('git', ['add', '.'], { cwd: historyFixture });
  execFileSync('git', ['commit', '-qm', 'candidate-controlled replay parent'], { cwd: historyFixture });

  // A multi-commit push can control its own first parent. Neither candidate
  // commit may lower the externally anchored production release baseline.
  writeFileSync(fixtureManifestPath, '{"firmwareVersion":"0.9.0"}\n');
  writeFileSync(fixtureVersionPath, '1.5.0\n');
  execFileSync('git', ['add', '.'], { cwd: historyFixture });
  execFileSync('git', ['commit', '-qm', 'candidate after replay parent'], { cwd: historyFixture });

  const calls = [];
  const productionFetch = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('release-manifest.json')) {
      return { ok: true, status: 200, text: async () => trustedManifest };
    }
    return { ok: true, status: 200, text: async () => trustedSignature };
  };

  await assert.rejects(
    checkPreviousProduction({
      fetchImpl: productionFetch,
      publicKeyPem: fixtureKeys.publicKey,
      versionPath: fixtureVersionPath,
    }),
    /must be greater than previous signed version 2\.0\.0/i,
  );
  assert.deepEqual(calls.map(([url]) => url), [
    'https://led.mandalacodes.com/firmware/release-manifest.json',
    'https://led.mandalacodes.com/firmware/release-manifest.sig',
  ]);
  for (const [, options] of calls) {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
  }

  writeFileSync(fixtureVersionPath, '2.1.0\n');
  assert.equal(await checkPreviousProduction({
    fetchImpl: productionFetch,
    publicKeyPem: fixtureKeys.publicKey,
    versionPath: fixtureVersionPath,
    write: () => {},
  }), '2.1.0');

  await assert.rejects(
    checkPreviousProduction({
      fetchImpl: async url => ({
        ok: true,
        status: 200,
        text: async () => url.endsWith('.sig') ? 'invalid-signature' : trustedManifest,
      }),
      publicKeyPem: fixtureKeys.publicKey,
      versionPath: fixtureVersionPath,
    }),
    /signature/i,
  );
  await assert.rejects(checkPreviousProduction({
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    publicKeyPem: fixtureKeys.publicKey,
    versionPath: fixtureVersionPath,
  }), /production firmware release.*503/i);
} finally {
  rmSync(historyFixture, { recursive: true, force: true });
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
assert.match(
  workflow,
  /--previous-production/,
  'the trusted predecessor version must come from the authenticated live release',
);
assert.doesNotMatch(workflow, /--previous-source|SOURCE_REVISION\^:/);
assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/);
assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'main'/);
assert.doesNotMatch(
  workflow,
  /require\('\.\/lightweaver\/public\/firmware\/release-manifest\.json'\)/,
  'a candidate must not lower its comparison baseline by replaying an old manifest',
);

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
assert.match(packageJson.scripts['ci:firmware-sensitive'], /firmware-version-policy\.mjs/);
console.log('firmware version policy tests passed');
