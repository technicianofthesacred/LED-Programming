#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const [packagePath, outputDir] = process.argv.slice(2);

if (!packagePath || !outputDir) {
  console.error('Usage: node scripts/unpack-standalone-package.mjs <package.json> <microSD-output-dir>');
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const prepared = preparePackage(packageJson, outputDir);
await installPreparedPackage(prepared);
console.log(`Standalone package unpacked to ${outputDir}`);

function preparePackage(packageJson, destinationRoot) {
  if (
    packageJson?.format !== 'standalone-controller-package'
    || !packageJson.files
    || typeof packageJson.files !== 'object'
    || Array.isArray(packageJson.files)
  ) {
    throw new Error('Expected a Lightweaver standalone-controller-package export');
  }

  const resolvedDestinationRoot = resolve(destinationRoot);
  const byPath = new Map();
  const byTargetFilesystemKey = new Map();
  for (const [packageFilePath, fileValue] of Object.entries(packageJson.files)) {
    const cleanPath = normalizePackagePath(packageFilePath);
    if (isReservedImmutablePath(cleanPath)) {
      throw new Error(`Package path uses the reserved immutable sequence namespace: ${packageFilePath}`);
    }
    if (byPath.has(cleanPath)) {
      throw new Error(`Duplicate normalized package path: ${packageFilePath}`);
    }
    const targetFilesystemKey = filesystemAliasKey(cleanPath);
    if (targetFilesystemKey === 'lightweaver.json' && cleanPath !== 'lightweaver.json') {
      throw new Error(`Package path aliases the reserved boot profile: ${packageFilePath}`);
    }
    const aliasedPath = byTargetFilesystemKey.get(targetFilesystemKey);
    if (aliasedPath) {
      throw new Error(`Target filesystem path alias collision: ${aliasedPath} and ${packageFilePath}`);
    }
    byTargetFilesystemKey.set(targetFilesystemKey, packageFilePath);

    const targetPath = join(resolvedDestinationRoot, cleanPath);
    const targetRelative = relative(resolvedDestinationRoot, targetPath);
    if (!targetRelative || targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
      throw new Error(`Unsafe package path: ${packageFilePath}`);
    }

    const bytes = encodeFileValue(packageFilePath, fileValue);
    byPath.set(cleanPath, {
      packageFilePath,
      cleanPath,
      targetPath,
      fileValue,
      bytes,
      temporaryPath: '',
    });
  }

  const profile = byPath.get('lightweaver.json');
  if (!profile) throw new Error('Package is missing /lightweaver.json');
  if (
    !profile.fileValue
    || typeof profile.fileValue !== 'object'
    || Array.isArray(profile.fileValue)
    || profile.fileValue.encoding
  ) {
    throw new Error('/lightweaver.json must contain a JSON boot profile');
  }
  const sequenceReferences = validateBootProfile(profile.fileValue, byPath);
  return prepareImmutableSequenceGeneration({
    profile,
    assets: [...byPath.values()].filter(entry => entry !== profile),
    sequenceReferences,
    destinationRoot: resolvedDestinationRoot,
  });
}

function normalizePackagePath(packageFilePath) {
  if (
    typeof packageFilePath !== 'string'
    || !packageFilePath
    || packageFilePath.includes('\0')
    || packageFilePath.includes('\\')
    || packageFilePath.startsWith('~')
  ) {
    throw new Error(`Unsafe package path: ${String(packageFilePath)}`);
  }
  const cleanPath = packageFilePath.startsWith('/') ? packageFilePath.slice(1) : packageFilePath;
  const segments = cleanPath.split('/');
  if (
    !cleanPath
    || segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe package path: ${packageFilePath}`);
  }
  return segments.join('/');
}

function isReservedImmutablePath(cleanPath) {
  const caseFoldedPath = filesystemAliasKey(cleanPath);
  return caseFoldedPath === 'sequences/.lw' || caseFoldedPath.startsWith('sequences/.lw/');
}

function filesystemAliasKey(cleanPath) {
  return cleanPath.normalize('NFC').toLowerCase();
}

function encodeFileValue(path, value) {
  if (value && typeof value === 'object' && value.encoding === 'base64') {
    if (typeof value.data !== 'string' || !isCanonicalBase64(value.data)) {
      throw new Error(`Invalid base64 content for ${path}`);
    }
    const bytes = Buffer.from(value.data, 'base64');
    verifyDeclaredIntegrity(path, value.bytes, value.sha256, bytes);
    return bytes;
  }
  if (value && typeof value === 'object' && value.encoding) {
    throw new Error(`Unsupported encoding for ${path}`);
  }
  if (value && typeof value === 'object') {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  }
  return Buffer.from(String(value ?? ''));
}

function isCanonicalBase64(value) {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function verifyDeclaredIntegrity(path, declaredBytes, declaredSha256, bytes) {
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== bytes.length) {
    throw new Error(`Invalid declared bytes for ${path}`);
  }
  if (typeof declaredSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(declaredSha256)) {
    throw new Error(`Missing declared sha256 for ${path}`);
  }
  const actual = sha256(bytes);
  if (actual !== declaredSha256) throw new Error(`SHA256 mismatch for ${path}`);
}

function validateBootProfile(profile, byPath) {
  const looks = profile.looks ?? [];
  if (!Array.isArray(looks)) throw new Error('/lightweaver.json has an invalid looks list');
  const sequenceReferences = [];
  const inheritedSequence = (profile.mode ?? profile.runtimeMode ?? 'sd-sequence') === 'sd-sequence';

  for (let index = 0; index < looks.length; index += 1) {
    const look = looks[index];
    if (!look || typeof look !== 'object' || Array.isArray(look)) {
      throw new Error(`Boot profile look ${index + 1} is invalid`);
    }
    const hasNativeRecipe = look.nativeRecipe != null || look.recipe != null;
    const requiresSequenceMetadata = !hasNativeRecipe
      && (look.mode != null ? look.mode === 'sequence' : inheritedSequence);
    if (!requiresSequenceMetadata) continue;

    const referencedPath = normalizePackagePath(look.file);
    const asset = byPath.get(referencedPath);
    if (!asset || asset.cleanPath === 'lightweaver.json') {
      throw new Error(`Boot profile referenced missing sequence asset: ${String(look.file)}`);
    }
    if (!Number.isSafeInteger(look.bytes) || look.bytes !== asset.bytes.length) {
      throw new Error(`Declared bytes in boot profile do not match ${look.file}`);
    }
    if (typeof look.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(look.sha256)) {
      throw new Error(`Boot profile is missing declared sha256 for ${look.file}`);
    }
    if (look.sha256 !== sha256(asset.bytes)) {
      throw new Error(`Declared sha256 in boot profile does not match ${look.file}`);
    }
    sequenceReferences.push({ lookIndex: index, asset });
  }

  if (
    profile.startupLook
    && !looks.some(look => look && typeof look === 'object' && look.id === profile.startupLook)
  ) {
    throw new Error('Boot profile startupLook does not reference a declared look');
  }
  return sequenceReferences;
}

function prepareImmutableSequenceGeneration({
  profile,
  assets,
  sequenceReferences,
  destinationRoot,
}) {
  const rewrittenProfile = JSON.parse(JSON.stringify(profile.fileValue));
  const referencedAssets = new Set();
  const immutableAssets = new Map();

  for (const { lookIndex, asset } of sequenceReferences) {
    const digest = sha256(asset.bytes);
    const cleanPath = `sequences/.lw/${digest}.lwseq`;
    rewrittenProfile.looks[lookIndex].file = `/${cleanPath}`;
    referencedAssets.add(asset);

    const existing = immutableAssets.get(cleanPath);
    if (existing && !existing.bytes.equals(asset.bytes)) {
      throw new Error(`Immutable sequence path collision: ${cleanPath}`);
    }
    if (!existing) {
      immutableAssets.set(cleanPath, {
        ...asset,
        packageFilePath: `/${cleanPath}`,
        cleanPath,
        targetPath: join(destinationRoot, cleanPath),
        temporaryPath: '',
      });
    }
  }

  const passthroughAssets = [];
  for (const asset of assets) {
    if (referencedAssets.has(asset)) continue;
    const caseFoldedPath = filesystemAliasKey(asset.cleanPath);
    if (caseFoldedPath.startsWith('sequences/') && caseFoldedPath.endsWith('.lwseq')) {
      throw new Error(`Unexpected unreferenced sequence asset: ${asset.packageFilePath}`);
    }
    const immutable = immutableAssets.get(asset.cleanPath);
    if (immutable) {
      if (!immutable.bytes.equals(asset.bytes)) {
        throw new Error(`Immutable sequence path collision: ${asset.cleanPath}`);
      }
      continue;
    }
    passthroughAssets.push(asset);
  }

  const rewrittenProfileEntry = {
    ...profile,
    fileValue: rewrittenProfile,
    bytes: Buffer.from(`${JSON.stringify(rewrittenProfile, null, 2)}\n`),
    temporaryPath: '',
  };
  return {
    profile: rewrittenProfileEntry,
    precommitAssets: [...immutableAssets.values()],
    postcommitAssets: passthroughAssets,
    destinationRoot,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function installPreparedPackage({
  profile,
  precommitAssets,
  postcommitAssets,
  destinationRoot,
}) {
  const entries = [...precommitAssets, profile, ...postcommitAssets];
  const staged = [];
  try {
    await preflightDestinationTopology(destinationRoot, entries);
    const destinationRealPath = await createSafeDestinationDirectories(destinationRoot, entries);

    for (const entry of entries) {
      await assertSafeEntryDestination(destinationRoot, destinationRealPath, entry);
      entry.temporaryPath = join(
        dirname(entry.targetPath),
        `.lightweaver-unpack-${process.pid}-${randomUUID()}-${basename(entry.targetPath)}.tmp`,
      );
      const handle = await open(entry.temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(entry.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push(entry);
    }

    for (const entry of precommitAssets) {
      await assertSafeEntryDestination(destinationRoot, destinationRealPath, entry);
      await rename(entry.temporaryPath, entry.targetPath);
      entry.temporaryPath = '';
      console.log(`Wrote ${entry.cleanPath}`);
      traceDurability(`renamed asset ${entry.cleanPath}`);
    }

    for (const directoryPath of durabilityDirectories(destinationRoot, precommitAssets)) {
      await syncDirectory(directoryPath);
      traceDurability(`synced directory ${displayDestinationPath(destinationRoot, directoryPath)}`);
    }

    if (
      process.env.NODE_ENV === 'test'
      && process.env.LIGHTWEAVER_UNPACK_TEST_FAIL_BEFORE_PROFILE_COMMIT === '1'
    ) {
      throw new Error('Injected failure before profile commit');
    }

    await assertSafeEntryDestination(destinationRoot, destinationRealPath, profile);
    await rename(profile.temporaryPath, profile.targetPath);
    profile.temporaryPath = '';
    console.log(`Wrote ${profile.cleanPath}`);
    traceDurability(`renamed profile ${profile.cleanPath}`);
    await syncDirectory(destinationRoot);
    traceDurability('synced directory .');

    for (const entry of postcommitAssets) {
      await assertSafeEntryDestination(destinationRoot, destinationRealPath, entry);
      await rename(entry.temporaryPath, entry.targetPath);
      entry.temporaryPath = '';
      console.log(`Wrote ${entry.cleanPath}`);
      traceDurability(`renamed postcommit asset ${entry.cleanPath}`);
    }
    for (const directoryPath of durabilityDirectories(destinationRoot, postcommitAssets)) {
      await syncDirectory(directoryPath);
      traceDurability(`synced directory ${displayDestinationPath(destinationRoot, directoryPath)}`);
    }
  } finally {
    await Promise.all(staged.map(entry => (
      entry.temporaryPath ? rm(entry.temporaryPath, { force: true }) : Promise.resolve()
    )));
  }
}

async function preflightDestinationTopology(destinationRoot, entries) {
  const rootStat = await lstatIfExists(destinationRoot);
  if (rootStat) {
    assertDirectoryStat(destinationRoot, rootStat);
  }

  for (const entry of entries) {
    if (!rootStat) break;
    let currentPath = destinationRoot;
    let allParentsExist = true;
    for (const segment of parentSegments(entry.cleanPath)) {
      currentPath = join(currentPath, segment);
      const currentStat = await lstatIfExists(currentPath);
      if (!currentStat) {
        allParentsExist = false;
        break;
      }
      assertDirectoryStat(currentPath, currentStat);
    }

    if (allParentsExist) {
      const targetStat = await lstatIfExists(entry.targetPath);
      if (targetStat?.isSymbolicLink()) {
        throw new Error(`Unsafe destination symlink: ${entry.cleanPath}`);
      }
      if (targetStat?.isDirectory()) {
        throw new Error(`Destination target is a directory: ${entry.cleanPath}`);
      }
    }
  }
}

async function createSafeDestinationDirectories(destinationRoot, entries) {
  await mkdir(destinationRoot, { recursive: true });
  assertDirectoryStat(destinationRoot, await lstat(destinationRoot));
  const destinationRealPath = await realpath(destinationRoot);

  const directories = new Set();
  for (const entry of entries) {
    let currentPath = destinationRoot;
    for (const segment of parentSegments(entry.cleanPath)) {
      currentPath = join(currentPath, segment);
      directories.add(currentPath);
    }
  }

  for (const directoryPath of [...directories].sort(pathDepthAscending)) {
    await mkdir(directoryPath).catch(error => {
      if (error?.code !== 'EEXIST') throw error;
    });
    assertDirectoryStat(directoryPath, await lstat(directoryPath));
    assertRealPathContained(destinationRealPath, await realpath(directoryPath), directoryPath);
  }
  return destinationRealPath;
}

async function assertSafeEntryDestination(destinationRoot, destinationRealPath, entry) {
  assertDirectoryStat(destinationRoot, await lstat(destinationRoot));
  assertRealPathContained(destinationRealPath, await realpath(destinationRoot), destinationRoot);

  let currentPath = destinationRoot;
  for (const segment of parentSegments(entry.cleanPath)) {
    currentPath = join(currentPath, segment);
    assertDirectoryStat(currentPath, await lstat(currentPath));
    assertRealPathContained(destinationRealPath, await realpath(currentPath), currentPath);
  }

  const targetStat = await lstatIfExists(entry.targetPath);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Unsafe destination symlink: ${entry.cleanPath}`);
  }
  if (targetStat?.isDirectory()) {
    throw new Error(`Destination target is a directory: ${entry.cleanPath}`);
  }
}

function parentSegments(cleanPath) {
  const segments = cleanPath.split('/');
  segments.pop();
  return segments;
}

function assertDirectoryStat(path, stat) {
  if (stat.isSymbolicLink()) throw new Error(`Unsafe destination symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`Destination parent is not a directory: ${path}`);
}

function assertRealPathContained(destinationRealPath, candidateRealPath, sourcePath) {
  const candidateRelative = relative(destinationRealPath, candidateRealPath);
  if (
    candidateRelative === '..'
    || candidateRelative.startsWith(`..${sep}`)
    || isAbsolute(candidateRelative)
  ) {
    throw new Error(`Unsafe destination path escapes output root: ${sourcePath}`);
  }
}

async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function durabilityDirectories(destinationRoot, entries) {
  const directories = new Set();
  for (const entry of entries) {
    let currentPath = dirname(entry.targetPath);
    while (true) {
      directories.add(currentPath);
      if (currentPath === destinationRoot) break;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        throw new Error(`Asset parent escapes destination root: ${entry.cleanPath}`);
      }
      currentPath = parentPath;
    }
  }
  return [...directories].sort(pathDepthDescending);
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory handles with fsync semantics through Node.
    // Ignore only the platform-specific "directory sync unsupported" results.
    if (
      process.platform === 'win32'
      && ['EISDIR', 'EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM'].includes(error?.code)
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function pathDepthAscending(left, right) {
  return left.split(sep).length - right.split(sep).length;
}

function pathDepthDescending(left, right) {
  return right.split(sep).length - left.split(sep).length;
}

function displayDestinationPath(destinationRoot, path) {
  return relative(destinationRoot, path) || '.';
}

function traceDurability(message) {
  if (
    process.env.NODE_ENV === 'test'
    && process.env.LIGHTWEAVER_UNPACK_TEST_TRACE_DURABILITY === '1'
  ) {
    console.log(`TRACE ${message}`);
  }
}
