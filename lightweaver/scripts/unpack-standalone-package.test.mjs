import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./unpack-standalone-package.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'lightweaver-unpack-'));
const sequenceBytes = Buffer.from('verified sequence bytes');
const sequenceSha256 = createHash('sha256').update(sequenceBytes).digest('hex');

function profile(file = '/sequences/demo.lwseq', overrides = {}) {
  return {
    version: 1,
    looks: [{
      mode: 'sequence',
      file,
      bytes: sequenceBytes.length,
      sha256: sequenceSha256,
      ...overrides,
    }],
  };
}

function encoded(bytes = sequenceBytes) {
  return {
    encoding: 'base64',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  };
}

function packageWith(files) {
  return { format: 'standalone-controller-package', files };
}

async function runPackage(name, pkg, output, env = {}) {
  const packagePath = join(root, `${name}.json`);
  await writeFile(packagePath, JSON.stringify(pkg));
  return spawnSync(process.execPath, [script, packagePath, output], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function allRelativeFiles(rootDir, prefix = '') {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await allRelativeFiles(join(rootDir, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('publishes the boot profile after every referenced asset', async () => {
  const output = join(root, 'valid-card');
  const run = await runPackage('valid', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
  }), output);
  assert.equal(run.status, 0, run.stderr);
  const immutablePath = `sequences/.lw/${sequenceSha256}.lwseq`;
  assert.deepEqual(await readFile(join(output, immutablePath)), sequenceBytes);
  assert.ok(
    run.stdout.indexOf(`Wrote ${immutablePath}`) < run.stdout.indexOf('Wrote lightweaver.json'),
    'the boot profile must be published after every referenced asset',
  );
});

test('validates and rewrites sequence looks that inherit sd-sequence mode', async () => {
  const output = join(root, 'inherited-sequence');
  const inheritedProfile = profile();
  inheritedProfile.mode = 'sd-sequence';
  delete inheritedProfile.looks[0].mode;
  const run = await runPackage('inherited-sequence', packageWith({
    '/lightweaver.json': inheritedProfile,
    '/sequences/demo.lwseq': encoded(),
  }), output);
  assert.equal(run.status, 0, run.stderr);

  const installedProfile = JSON.parse(await readFile(join(output, 'lightweaver.json'), 'utf8'));
  assert.equal(installedProfile.looks[0].mode, undefined);
  assert.equal(installedProfile.looks[0].file, `/sequences/.lw/${sequenceSha256}.lwseq`);
  assert.deepEqual(
    await readFile(join(output, installedProfile.looks[0].file.replace(/^\/+/, ''))),
    sequenceBytes,
  );
});

test('rejects a missing asset referenced by a look that inherits sd-sequence mode', async () => {
  const output = join(root, 'inherited-missing-sequence');
  const inheritedProfile = profile('/sequences/missing.lwseq');
  inheritedProfile.mode = 'sd-sequence';
  delete inheritedProfile.looks[0].mode;
  const run = await runPackage('inherited-missing-sequence', packageWith({
    '/lightweaver.json': inheritedProfile,
  }), output);
  assert.notEqual(run.status, 0, 'an inherited sequence look must validate its asset');
  assert.match(run.stderr, /missing.*sequence|referenced.*missing/i);
  assert.deepEqual(await allRelativeFiles(output), []);
});

test('canonical runtimeMode sd-sequence rewrites a look with no explicit mode', async () => {
  const output = join(root, 'runtime-mode-sequence');
  const inheritedProfile = profile();
  inheritedProfile.runtimeMode = 'sd-sequence';
  delete inheritedProfile.looks[0].mode;
  const run = await runPackage('runtime-mode-sequence', packageWith({
    '/lightweaver.json': inheritedProfile,
    '/sequences/demo.lwseq': encoded(),
  }), output);
  assert.equal(run.status, 0, run.stderr);

  const installedProfile = JSON.parse(await readFile(join(output, 'lightweaver.json'), 'utf8'));
  assert.equal(installedProfile.looks[0].file, `/sequences/.lw/${sequenceSha256}.lwseq`);
});

test('SD install defaults a missing profile and look mode to sequence', async () => {
  const output = join(root, 'sd-default-sequence');
  const inheritedProfile = profile();
  delete inheritedProfile.looks[0].mode;
  const run = await runPackage('sd-default-sequence', packageWith({
    '/lightweaver.json': inheritedProfile,
    '/sequences/demo.lwseq': encoded(),
  }), output);
  assert.equal(run.status, 0, run.stderr);

  const installedProfile = JSON.parse(await readFile(join(output, 'lightweaver.json'), 'utf8'));
  assert.equal(installedProfile.looks[0].file, `/sequences/.lw/${sequenceSha256}.lwseq`);
});

test('native recipes override inherited sequence mode without requiring sequence metadata', async () => {
  const output = join(root, 'native-recipe');
  const recipeProfile = profile('/sequences/not-present.lwseq');
  recipeProfile.runtimeMode = 'sd-sequence';
  delete recipeProfile.looks[0].mode;
  delete recipeProfile.looks[0].bytes;
  delete recipeProfile.looks[0].sha256;
  recipeProfile.looks[0].nativeRecipe = { version: 1, nodes: [] };
  const run = await runPackage('native-recipe', packageWith({
    '/lightweaver.json': recipeProfile,
  }), output);
  assert.equal(run.status, 0, run.stderr);

  const installedProfile = JSON.parse(await readFile(join(output, 'lightweaver.json'), 'utf8'));
  assert.equal(installedProfile.looks[0].file, '/sequences/not-present.lwseq');
});

test('validates every package entry before writing any destination file', async () => {
  const validateFirstOutput = join(root, 'validate-first');
  const tampered = encoded();
  tampered.data = Buffer.from('tampered').toString('base64');
  const run = await runPackage('tampered', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/valid-before-tamper.lwseq': encoded(),
    '/sequences/demo.lwseq': tampered,
  }), validateFirstOutput);
  assert.notEqual(run.status, 0, 'tampered sequence package must be rejected');
  assert.match(run.stderr, /sha256|bytes/i);
  assert.deepEqual(
    await allRelativeFiles(validateFirstOutput),
    [],
    'every file must validate before any destination file is written',
  );
});

for (const [name, files, expected] of [
  ['missing-profile', { '/sequences/demo.lwseq': encoded() }, /lightweaver\.json/i],
  ['missing-reference', { '/lightweaver.json': profile('/sequences/missing.lwseq') }, /missing.*sequence|referenced.*missing/i],
  ['profile-integrity-mismatch', {
    '/lightweaver.json': profile('/sequences/demo.lwseq', { bytes: sequenceBytes.length + 1 }),
    '/sequences/demo.lwseq': encoded(),
  }, /bytes.*profile|profile.*bytes/i],
  ['unsafe-path', {
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
    '/sequences/../escape.lwseq': encoded(),
  }, /unsafe.*path/i],
  ['duplicate-normalized-path', {
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
    'sequences/demo.lwseq': encoded(),
  }, /duplicate.*path/i],
]) {
  test(`rejects ${name.replaceAll('-', ' ')} packages before writing`, async () => {
    const invalidOutput = join(root, name);
    const run = await runPackage(name, packageWith(files), invalidOutput);
    assert.notEqual(run.status, 0, `${name} package must be rejected`);
    assert.match(run.stderr, expected);
    assert.deepEqual(await allRelativeFiles(invalidOutput), []);
  });
}

test('an interruption before profile commit preserves the old profile and cleans temporary files', async () => {
  const interruptedOutput = join(root, 'interrupted');
  await mkdir(join(interruptedOutput, 'sequences'), { recursive: true });
  const previousSequence = Buffer.from('previous known-good sequence');
  const previousSequenceSha256 = createHash('sha256').update(previousSequence).digest('hex');
  const previousProfile = `${JSON.stringify({
    version: 1,
    runtimeMode: 'sequence',
    looks: [{
      id: 'previous',
      mode: 'sequence',
      file: '/sequences/demo.lwseq',
      bytes: previousSequence.length,
      sha256: previousSequenceSha256,
    }],
  }, null, 2)}\n`;
  await writeFile(join(interruptedOutput, 'lightweaver.json'), previousProfile);
  await writeFile(join(interruptedOutput, 'sequences/demo.lwseq'), previousSequence);
  const run = await runPackage('interrupted', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
  }), interruptedOutput, {
    NODE_ENV: 'test',
    LIGHTWEAVER_UNPACK_TEST_FAIL_BEFORE_PROFILE_COMMIT: '1',
  });
  assert.notEqual(run.status, 0, 'the deterministic pre-commit interruption must fail');
  assert.match(run.stderr, /injected.*profile commit/i);
  assert.equal(
    await readFile(join(interruptedOutput, 'lightweaver.json'), 'utf8'),
    previousProfile,
    'failure before the commit point must preserve the prior boot-visible profile',
  );
  assert.deepEqual(
    await readFile(join(interruptedOutput, 'sequences/demo.lwseq')),
    previousSequence,
    'failure before profile commit must not overwrite an asset referenced by the old profile',
  );
  assert.deepEqual(
    (await allRelativeFiles(interruptedOutput)).filter(path => /\.tmp-|\.lightweaver-unpack-/.test(path)),
    [],
    'failed installs must clean same-directory temporary files',
  );
});

test('an unreferenced mutable sequence cannot overwrite the old generation before profile commit', async () => {
  const output = join(root, 'unreferenced-sequence-interrupted');
  const previousSequence = Buffer.from('old mutable sequence');
  const previousSha256 = createHash('sha256').update(previousSequence).digest('hex');
  const previousProfile = `${JSON.stringify({
    version: 1,
    mode: 'sd-sequence',
    looks: [{
      id: 'previous',
      mode: 'sequence',
      file: '/sequences/old.lwseq',
      bytes: previousSequence.length,
      sha256: previousSha256,
    }],
  }, null, 2)}\n`;
  await mkdir(join(output, 'sequences'), { recursive: true });
  await writeFile(join(output, 'lightweaver.json'), previousProfile);
  await writeFile(join(output, 'sequences/old.lwseq'), previousSequence);

  const run = await runPackage('unreferenced-sequence-interrupted', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
    '/sequences/old.lwseq': encoded(Buffer.from('hostile unreferenced sequence')),
  }), output, {
    NODE_ENV: 'test',
    LIGHTWEAVER_UNPACK_TEST_FAIL_BEFORE_PROFILE_COMMIT: '1',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unexpected|unreferenced.*sequence/i);
  assert.equal(await readFile(join(output, 'lightweaver.json'), 'utf8'), previousProfile);
  assert.deepEqual(
    await readFile(join(output, 'sequences/old.lwseq')),
    previousSequence,
    'an unreferenced incoming sequence must not replace bytes used by the old profile',
  );
});

test('publishes non-referenced sidecars only after the new profile commits', async () => {
  const output = join(root, 'postcommit-sidecar');
  const run = await runPackage('postcommit-sidecar', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
    '/sequences/demo.lwseq.json': '{"sidecar":true}\n',
  }), output, {
    NODE_ENV: 'test',
    LIGHTWEAVER_UNPACK_TEST_TRACE_DURABILITY: '1',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(
    run.stdout.indexOf('Wrote lightweaver.json')
      < run.stdout.indexOf('Wrote sequences/demo.lwseq.json'),
    'unreferenced sidecars must publish after the boot profile',
  );
  assert.equal(
    await readFile(join(output, 'sequences/demo.lwseq.json'), 'utf8'),
    '{"sidecar":true}\n',
  );
});

test('reserved immutable paths cannot overwrite an old generation before profile commit', async () => {
  const output = join(root, 'reserved-path-interrupted');
  const previousSequence = Buffer.from('old immutable sequence');
  const previousSha256 = createHash('sha256').update(previousSequence).digest('hex');
  const previousFile = `/sequences/.lw/${previousSha256}.lwseq`;
  const previousProfile = `${JSON.stringify({
    version: 1,
    mode: 'sd-sequence',
    looks: [{
      id: 'previous',
      mode: 'sequence',
      file: previousFile,
      bytes: previousSequence.length,
      sha256: previousSha256,
    }],
  }, null, 2)}\n`;
  await mkdir(join(output, 'sequences/.lw'), { recursive: true });
  await writeFile(join(output, 'lightweaver.json'), previousProfile);
  await writeFile(join(output, previousFile.replace(/^\/+/, '')), previousSequence);

  const hostileBytes = Buffer.from('hostile unreferenced replacement');
  const packageReservedFile = previousFile.replace('/.lw/', '/.LW/');
  const run = await runPackage('reserved-path-interrupted', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
    [packageReservedFile]: encoded(hostileBytes),
  }), output, {
    NODE_ENV: 'test',
    LIGHTWEAVER_UNPACK_TEST_FAIL_BEFORE_PROFILE_COMMIT: '1',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /reserved|immutable/i);
  assert.equal(await readFile(join(output, 'lightweaver.json'), 'utf8'), previousProfile);
  assert.deepEqual(
    await readFile(join(output, previousFile.replace(/^\/+/, ''))),
    previousSequence,
    'package-supplied passthrough content must never replace an old immutable asset',
  );
});

test('case-insensitive aliases of the boot profile are rejected before interruption can overwrite it', async () => {
  const output = join(root, 'profile-alias-interrupted');
  await mkdir(output, { recursive: true });
  const previousProfile = '{"version":1,"generation":"previous"}\n';
  await writeFile(join(output, 'lightweaver.json'), previousProfile);

  const run = await runPackage('profile-alias-interrupted', packageWith({
    '/lightweaver.json': profile(),
    '/LIGHTWEAVER.JSON': '{"generation":"hostile alias"}\n',
    '/sequences/demo.lwseq': encoded(),
  }), output, {
    NODE_ENV: 'test',
    LIGHTWEAVER_UNPACK_TEST_FAIL_BEFORE_PROFILE_COMMIT: '1',
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /alias|collision|reserved/i);
  assert.equal(
    await readFile(join(output, 'lightweaver.json'), 'utf8'),
    previousProfile,
    'an alias of the reserved boot profile must not replace the old profile',
  );
});

test('Unicode-normalized package path aliases are rejected before writing', async () => {
  const output = join(root, 'unicode-alias');
  const run = await runPackage('unicode-alias', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
    '/assets/café.txt': 'one',
    '/assets/cafe\u0301.txt': 'two',
  }), output);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /alias|collision/i);
  assert.deepEqual(await allRelativeFiles(output), []);
});

test('rejects symlinked destination parents without writing outside the output root', async () => {
  const output = join(root, 'symlink-card');
  const outside = join(root, 'symlink-outside');
  await mkdir(output, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(output, 'sequences'), 'dir');

  const run = await runPackage('symlink-parent', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
  }), output);
  assert.notEqual(run.status, 0, 'symlinked destination parents must be rejected');
  assert.match(run.stderr, /symlink|unsafe.*destination/i);
  assert.deepEqual(
    await allRelativeFiles(outside),
    [],
    'a symlinked parent must not redirect writes outside the output root',
  );
});

test('syncs asset directories before profile commit and the root after profile commit', async () => {
  const output = join(root, 'durability-order');
  const run = await runPackage('durability-order', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
  }), output, {
    NODE_ENV: 'test',
    LIGHTWEAVER_UNPACK_TEST_TRACE_DURABILITY: '1',
  });
  assert.equal(run.status, 0, run.stderr);

  const assetRename = run.stdout.indexOf(`TRACE renamed asset sequences/.lw/${sequenceSha256}.lwseq`);
  const assetDirectorySync = run.stdout.indexOf('TRACE synced directory sequences/.lw');
  const profileRename = run.stdout.indexOf('TRACE renamed profile lightweaver.json');
  const rootSync = run.stdout.lastIndexOf('TRACE synced directory .');
  assert.ok(assetRename >= 0, 'asset rename must be observable in the durability trace');
  assert.ok(assetDirectorySync > assetRename, 'asset parent must sync after asset rename');
  assert.ok(profileRename > assetDirectorySync, 'profile must commit after asset directory sync');
  assert.ok(rootSync > profileRename, 'root must sync after profile rename');
});

test('successful install publishes immutable sequence paths with matching profile integrity', async () => {
  const output = join(root, 'immutable-success');
  const run = await runPackage('immutable-success', packageWith({
    '/lightweaver.json': profile(),
    '/sequences/demo.lwseq': encoded(),
  }), output);
  assert.equal(run.status, 0, run.stderr);

  const installedProfile = JSON.parse(await readFile(join(output, 'lightweaver.json'), 'utf8'));
  const installedLook = installedProfile.looks[0];
  assert.equal(installedLook.file, `/sequences/.lw/${sequenceSha256}.lwseq`);
  const installedSequence = await readFile(join(output, installedLook.file.replace(/^\/+/, '')));
  assert.equal(installedSequence.length, installedLook.bytes);
  assert.equal(createHash('sha256').update(installedSequence).digest('hex'), installedLook.sha256);
  assert.deepEqual(installedSequence, sequenceBytes);
});
