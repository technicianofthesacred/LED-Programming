// Establishes ONE fact for lane classification: did this revision change the
// card-embedded Studio bundle, byte for byte, relative to the last protected
// signer run? When the answer is a proven "no", scripts/ci-changed-lanes.mjs
// may drop the firmware lane for Studio-only changes, so a site tweak deploys
// in minutes instead of waiting for the firmware signer.
//
// Fail-closed by construction: this script only ever ADDS the
// CI_CARD_BUNDLE_UNCHANGED=true fact, and only after a successful canonical
// build whose bundleSha256 equals the hash the signer recorded in
// lightweaver/public/firmware/card-bundle-canonical.json. Any error, missing
// record, or mismatch leaves the environment untouched and classification
// behaves exactly as before this script existed.
//
// Usage (both forms skip all work unless the diff makes the answer relevant):
//   node scripts/ci-card-bundle-check.mjs            # append to $GITHUB_ENV
//   node scripts/ci-card-bundle-check.mjs --print    # print true/false only
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyChangedPaths, resolveChangedPaths } from './ci-changed-lanes.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD_PATH = resolve(repositoryRoot, 'lightweaver', 'public', 'firmware', 'card-bundle-canonical.json');

function report(print, unchanged, reason) {
  process.stderr.write(`card-bundle-check: ${unchanged ? 'UNCHANGED' : 'not proven unchanged'} — ${reason}\n`);
  if (print) {
    process.stdout.write(unchanged ? 'true\n' : 'false\n');
  } else if (unchanged && process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, 'CI_CARD_BUNDLE_UNCHANGED=true\n');
  }
}

export function cardBundleCheckRelevant(paths, conservative) {
  if (conservative) return false;
  // Relevant exactly when the firmware lane's answer depends on the bundle:
  // classification WITH the unchanged fact differs from classification without.
  const withFact = classifyChangedPaths(paths, { cardBundleUnchanged: true });
  const withoutFact = classifyChangedPaths(paths, { cardBundleUnchanged: false });
  return withoutFact.firmware === true && withFact.firmware === false;
}

function main() {
  const print = process.argv.includes('--print');
  try {
    const resolved = resolveChangedPaths({
      before: process.env.CI_BASE_SHA || '',
      head: process.env.CI_HEAD_SHA || '',
    });
    if (!cardBundleCheckRelevant(resolved.paths, resolved.conservative)) {
      return report(print, false, 'not relevant to this diff; firmware lane unaffected by the bundle question');
    }
    if (!existsSync(RECORD_PATH)) {
      return report(print, false, 'no signed canonical record yet (first signer run after this feature will create it)');
    }
    const record = JSON.parse(readFileSync(RECORD_PATH, 'utf8'));
    if (!/^[a-f0-9]{64}$/.test(record?.bundleSha256 || '')) {
      return report(print, false, 'recorded canonical hash is malformed');
    }
    const lightweaver = resolve(repositoryRoot, 'lightweaver');
    if (!existsSync(resolve(lightweaver, 'node_modules', '.bin', 'vite'))) {
      execFileSync('npm', ['ci', '--prefix', lightweaver], { stdio: 'inherit' });
    }
    execFileSync('npm', ['run', 'fonts:prepare', '--silent', '--prefix', lightweaver], { stdio: 'inherit' });
    const output = execFileSync('node', [resolve(lightweaver, 'scripts', 'build-card-studio.mjs'), '--canonical'], {
      cwd: lightweaver, encoding: 'utf8',
    });
    const built = JSON.parse(output.trim().split('\n').pop());
    if (built?.bundleSha256 === record.bundleSha256) {
      return report(print, true, `canonical bundle ${built.bundleSha256.slice(0, 16)}… matches the signed record`);
    }
    return report(print, false, `canonical bundle ${String(built?.bundleSha256 || '').slice(0, 16)}… differs from signed ${record.bundleSha256.slice(0, 16)}…`);
  } catch (error) {
    return report(print, false, `check failed safely: ${error?.message || error}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
