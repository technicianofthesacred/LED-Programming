/* Browser-side deployment self-check.
 *
 * Runs the same artifact verification the deploy-time `check:prod` script
 * performs, but same-origin from the served Studio itself — so the deployed
 * site can be verified from any phone or laptop with no repo clone and no
 * Node install: open the site, run the check, read green/red rows.
 *
 * What it proves: the live origin serves a coherent, signed release —
 * manifest signature valid against the pinned Lightweaver release key,
 * factory image hash matching the signed manifest, provenance matching the
 * manifest, every indexed production job artifact matching its
 * content-addressed digest, and the required cache policies.
 *
 * Honest boundary (also shown in the UI): a page can only be as independent
 * as the origin that served it. This catches the realistic deployment
 * failures — stale or partial publishes, wrong artifacts, broken cache
 * policy, CDN corruption — but the fully independent audit against the
 * committed repository remains `npm run check:prod` from a checkout.
 */
import {
  verifyProductionCachePolicies,
  verifyProductionReleaseSet,
} from './productionReleaseGate.js';

export const DEPLOYMENT_CHECKS = Object.freeze([
  { id: 'release-set', label: 'Signed firmware release (manifest signature, image hash, provenance, job artifacts)' },
  { id: 'cache-policies', label: 'Production cache policies (mutable no-store, immutable content-addressed)' },
]);

function failure(error) {
  const message = String(error?.message || error || 'Unknown failure');
  // Same-origin fetches never carry credentials/tokens here; keep the first
  // line only so a support screenshot stays compact and free of noise.
  return message.split('\n')[0].slice(0, 300);
}

export async function runDeploymentSelfCheck({
  fetchImpl,
  cryptoImpl,
  verifyReleaseSet = verifyProductionReleaseSet,
  verifyCachePolicies = verifyProductionCachePolicies,
} = {}) {
  const doFetch = fetchImpl
    || ((path, options) => fetch(path, { ...options, credentials: 'omit' }));
  const doCrypto = cryptoImpl || globalThis.crypto;

  const results = [];
  let releaseSet = null;
  let summary = null;

  try {
    releaseSet = await verifyReleaseSet(doFetch, doCrypto);
    const manifest = releaseSet.release?.manifest || {};
    summary = {
      firmwareVersion: manifest.firmwareVersion || 'unknown',
      buildId: manifest.buildId || 'unknown',
      sourceRevision: manifest.provenance?.sourceRevision || 'unknown',
      jobCount: releaseSet.jobIndex?.jobs?.length ?? 0,
    };
    results.push({ id: 'release-set', ok: true, detail: `v${summary.firmwareVersion} · build ${String(summary.buildId).slice(0, 12)} · ${summary.jobCount} signed job${summary.jobCount === 1 ? '' : 's'}` });
  } catch (error) {
    results.push({ id: 'release-set', ok: false, detail: failure(error) });
  }

  if (releaseSet) {
    try {
      await verifyCachePolicies(doFetch, releaseSet);
      results.push({ id: 'cache-policies', ok: true, detail: 'no-store on mutable assets; one-year immutable on content-addressed assets' });
    } catch (error) {
      results.push({ id: 'cache-policies', ok: false, detail: failure(error) });
    }
  } else {
    results.push({ id: 'cache-policies', ok: false, detail: 'Skipped — the signed release set could not be verified first.' });
  }

  const labelled = results.map(result => ({
    ...result,
    label: DEPLOYMENT_CHECKS.find(check => check.id === result.id)?.label || result.id,
  }));
  return { ok: labelled.every(result => result.ok), results: labelled, summary };
}
