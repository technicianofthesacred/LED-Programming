#!/usr/bin/env node
import { createHash, createPrivateKey, randomBytes, sign as signBytes, webcrypto } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import {
  buildProductionJob,
  canonicalProductionJobBytes,
  MAX_PRODUCTION_JOB_BYTES,
  PRODUCTION_JOB_ACTIVE_SIGNING_KEY_ID,
  PRODUCTION_JOB_SIGNATURE_ALGORITHM,
  productionJobSignedBytes,
  validateProductionJobIndex,
} from '../lightweaver/src/lib/productionJobPackage.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argumentsMap(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Missing value for ${key || 'argument'}`);
    result.set(key.slice(2), value);
  }
  return result;
}

function required(args, name, fallback) {
  const value = args.get(name) ?? fallback;
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function withIndexLock(indexPath, callback) {
  const lockPath = `${indexPath}.lock`;
  const attempts = Math.max(1, Number(process.env.LW_JOB_LOCK_ATTEMPTS) || 200);
  const retryMs = Math.max(1, Number(process.env.LW_JOB_LOCK_RETRY_MS) || 10);
  const staleMs = 30_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let acquired = false;
    try {
      await mkdir(lockPath);
      acquired = true;
      const owner = { version: 1, pid: process.pid, createdAt: Date.now(), nonce: randomBytes(16).toString('hex') };
      try { await writeFile(resolve(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx' }); }
      catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
      try { return await callback(); }
      finally { await rm(lockPath, { recursive: true, force: true }); }
    } catch (error) {
      if (acquired) throw error;
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      let age = 0;
      try {
        owner = JSON.parse(await readFile(resolve(lockPath, 'owner.json'), 'utf8'));
        age = Date.now() - owner.createdAt;
      } catch {
        try { age = Date.now() - (await stat(lockPath)).mtimeMs; } catch {}
      }
      const validOwner = owner?.version === 1 && Number.isSafeInteger(owner.pid) && owner.pid > 0
        && Number.isFinite(owner.createdAt) && /^[a-f0-9]{32}$/.test(owner.nonce || '');
      let alive = false;
      if (validOwner) {
        try { process.kill(owner.pid, 0); alive = true; }
        catch (probeError) { alive = probeError?.code !== 'ESRCH'; }
      }
      if (age > staleMs && (!validOwner || !alive)) {
        const abandoned = `${lockPath}.abandoned.${process.pid}.${randomBytes(8).toString('hex')}`;
        try { await rename(lockPath, abandoned); await rm(abandoned, { recursive: true, force: true }); continue; }
        catch (reclaimError) { if (!['ENOENT', 'EEXIST'].includes(reclaimError?.code)) throw reclaimError; }
      }
      await delay(retryMs);
    }
  }
  throw new Error('Production job index is locked by another builder');
}

const args = argumentsMap(process.argv.slice(2));
const inputPath = resolve(required(args, 'input'));
const publicRoot = resolve(required(args, 'public-root', resolve(repoRoot, 'lightweaver/public')));
const jobsDirectory = resolve(publicRoot, 'production/jobs');
const indexPath = resolve(jobsDirectory, 'index.json');

let source;
try {
  source = JSON.parse(await readFile(inputPath, 'utf8'));
} catch (error) {
  throw new Error(`Unable to read production job source: ${error.message}`);
}

const job = await buildProductionJob(source, { cryptoImpl: webcrypto });
const artifact = canonicalProductionJobBytes(job);
if (artifact.byteLength > MAX_PRODUCTION_JOB_BYTES) throw new Error('Production job exceeds the 256 KiB UTF-8 package limit');
const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
const artifactPath = resolve(jobsDirectory, `${job.digest}.lwjob.json`);
const signingKeyPath = args.get('signing-key') || process.env.LIGHTWEAVER_PRODUCTION_JOB_SIGNING_KEY || '';
const signingKeyId = args.get('signing-key-id') || PRODUCTION_JOB_ACTIVE_SIGNING_KEY_ID;

let existingArtifact = null;
try { existingArtifact = await readFile(artifactPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
if (existingArtifact && !existingArtifact.equals(artifact)) throw new Error(`Immutable production job collision at ${artifactPath}`);
if (!existingArtifact) await atomicWrite(artifactPath, artifact);

let signaturePath;
if (signingKeyPath) {
  const keyPath = resolve(signingKeyPath);
  const keyStats = await stat(keyPath);
  if ((keyStats.mode & 0o077) !== 0) throw new Error('Production job signing key permissions must not allow group or other access');
  const privateKey = createPrivateKey(await readFile(keyPath));
  const signature = signBytes('sha256', productionJobSignedBytes(artifact, signingKeyId), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  if (signature.byteLength !== 64) throw new Error('Production job signing failed');
  const envelope = {
    keyId: signingKeyId,
    algorithm: PRODUCTION_JOB_SIGNATURE_ALGORITHM,
    value: signature.toString('base64url'),
  };
  signaturePath = resolve(jobsDirectory, `${job.digest}.lwjob.sig.json`);
  await atomicWrite(signaturePath, `${JSON.stringify(envelope)}\n`);
}

const entry = {
  jobId: job.jobId,
  label: job.label,
  digest: job.digest,
  artifactSha256,
  size: artifact.byteLength,
  url: `/production/jobs/${job.digest}.lwjob.json`,
};
await mkdir(dirname(indexPath), { recursive: true });
await withIndexLock(indexPath, async () => {
  let index = { schemaVersion: 1, jobs: [] };
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  validateProductionJobIndex(index);
  index.jobs = [...index.jobs.filter(item => item.jobId !== job.jobId), entry]
    .sort((left, right) => left.jobId.localeCompare(right.jobId) || left.digest.localeCompare(right.digest));
  validateProductionJobIndex(index);
  await atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
});

console.log(JSON.stringify({ digest: job.digest, artifactSha256, artifactPath, indexPath, ...(signaturePath ? { signaturePath } : {}) }));
