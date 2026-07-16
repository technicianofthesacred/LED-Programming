import { loadProductionFirmwareRelease } from './firmwareRelease.js';
import { loadProductionJobFromIndexEntry, loadProductionJobIndex } from './productionJobPackage.js';
import {
  FACTORY_FIRMWARE_PATH,
  FIRMWARE_MANIFEST_PATH,
  FIRMWARE_PROVENANCE_PATH,
  FIRMWARE_SIGNATURE_PATH,
  PRODUCTION_JOB_INDEX_PATH,
  assertReleaseProvenance,
} from './productionDeploymentCheck.js';

const ONE_YEAR_SECONDS = 31_536_000;

export async function verifyProductionReleaseSet(fetchImpl, cryptoImpl) {
  const release = await loadProductionFirmwareRelease(fetchImpl, cryptoImpl);
  const provenanceResponse = await fetchImpl(FIRMWARE_PROVENANCE_PATH, {
    cache: 'no-store', credentials: 'omit', redirect: 'error',
  });
  await assertReleaseProvenance(provenanceResponse, release.manifest, FIRMWARE_PROVENANCE_PATH);
  const jobIndex = await loadProductionJobIndex(fetchImpl);
  const jobs = [];
  for (const entry of jobIndex.jobs) {
    jobs.push(await loadProductionJobFromIndexEntry(entry, { fetchImpl, cryptoImpl }));
  }
  return { release, jobIndex, jobs };
}

async function cacheHeaders(fetchImpl, url) {
  const options = { cache: 'no-store', credentials: 'omit', redirect: 'error' };
  let head;
  try { head = await fetchImpl(url, { ...options, method: 'HEAD' }); } catch { head = null; }
  if (head?.ok && head.headers?.get?.('cache-control')) return head.headers;

  const response = await fetchImpl(url, { ...options, method: 'GET', headers: { Range: 'bytes=0-0' } });
  try {
    if (!response?.ok && response?.status !== 206) throw new Error(`Cache policy check answered HTTP ${response?.status ?? 'unknown'} for ${url}`);
    return response.headers;
  } finally {
    await response?.body?.cancel?.();
  }
}

function directives(headers) {
  return String(headers?.get?.('cache-control') || '').toLowerCase();
}

async function requireMutable(fetchImpl, url) {
  const value = directives(await cacheHeaders(fetchImpl, url));
  if (!/(?:^|,)\s*no-store(?:\s*(?:,|$))/.test(value)) {
    throw new Error(`Mutable production asset must use no-store: ${url}`);
  }
}

async function requireImmutable(fetchImpl, url) {
  const value = directives(await cacheHeaders(fetchImpl, url));
  const maximum = /(?:^|,)\s*max-age=(\d+)(?:\s*(?:,|$))/.exec(value);
  if (!/(?:^|,)\s*public(?:\s*(?:,|$))/.test(value)
    || !/(?:^|,)\s*immutable(?:\s*(?:,|$))/.test(value)
    || !maximum || Number(maximum[1]) < ONE_YEAR_SECONDS) {
    throw new Error(`Content-addressed production asset must be public with one-year immutable caching: ${url}`);
  }
}

export async function verifyProductionCachePolicies(fetchImpl, { release, jobIndex }) {
  for (const url of [
    FIRMWARE_MANIFEST_PATH,
    FIRMWARE_SIGNATURE_PATH,
    FIRMWARE_PROVENANCE_PATH,
    FACTORY_FIRMWARE_PATH,
    PRODUCTION_JOB_INDEX_PATH,
  ]) await requireMutable(fetchImpl, url);

  await requireImmutable(fetchImpl, release.manifest.image.url);
  for (const entry of jobIndex.jobs) await requireImmutable(fetchImpl, entry.url);
}
