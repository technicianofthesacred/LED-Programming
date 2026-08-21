// Answers, in about two seconds and without any network or compile, what CI
// will demand of the current branch — so a policy refusal costs one local run
// instead of a 10–20 minute CI round-trip. Run it before pushing:
//
//   node scripts/ci-preflight.mjs            # diff vs origin/main
//   node scripts/ci-preflight.mjs main       # diff vs another base
//
// It reports:
//   1. which CI lanes the diff selects (the same classifier CI runs);
//   2. whether a firmware-sensitive change needs a VERSION bump the signer
//      will accept (the check that otherwise fails only in the firmware job),
//      and whether this revision produces a signed card release at all —
//      Studio-only revisions do not, so they deploy without one;
//   3. the pages-staging source guards that scan exact files (no cloud
//      library or /design references in card command and flashing paths).
//
// It deliberately does NOT run test suites — it exists to catch the policy
// failures that are invisible locally, not to replace `npm run launch:check`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { classifyChangedPaths, LANE_NAMES } from './ci-changed-lanes.mjs';
import { cardBundleCheckRelevant } from './ci-card-bundle-check.mjs';
import { firmwareBundleOnly } from './ci-changed-lanes.mjs';
import { countInWords, readRegister } from './firmware-queue.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
// NOT trimmed: an unstaged porcelain line begins with a space (" M path"), and
// trimming the whole block eats that space on the FIRST line only — which then
// cost that path its first character and silently misclassified its CI lanes.
const gitRaw = (...args) => execFileSync('git', args, { encoding: 'utf8' });

const base = process.argv[2] || 'origin/main';
const mergeBase = git('merge-base', base, 'HEAD');
const committed = git('diff', '--name-only', `${mergeBase}..HEAD`).split('\n').filter(Boolean);
const uncommitted = gitRaw('status', '--porcelain')
  .split('\n')
  .filter(Boolean)
  .map(line => line.slice(3).replace(/^"|"$/g, ''));
const paths = [...new Set([...committed, ...uncommitted])];

const problems = [];
const lanes = classifyChangedPaths(paths);
const selected = LANE_NAMES.filter(name => lanes[name]);
console.log(`Changed paths vs ${base}: ${paths.length}`);
console.log(`CI lanes: ${selected.join(', ') || '(none — CI runs nothing)'}`);

// Printed on every run, not only on failure: the waiting list is only useful
// if it is impossible to forget it exists.
const waiting = readRegister().waiting;
console.log(waiting.length === 0
  ? 'Waiting for the next card update: nothing.'
  : `Waiting for the next card update: ${countInWords(waiting.length).toLowerCase()} `
    + `${waiting.length === 1 ? 'change' : 'changes'} (npm run firmware:waiting).`);

function versionNumbers(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  return match ? match.slice(1).map(Number) : null;
}

// Firmware-sensitive only because Studio source is embedded in the card
// bundle: no signed release is produced for this revision, so no VERSION bump
// is demanded and the site deploys straight away. A card release is on demand
// — bump VERSION when you want one.
const bundleOnly = firmwareBundleOnly(paths);
if (bundleOnly) {
  console.log('Card release: none — Studio-only revision, so the site deploys without waiting for the signer.');
  console.log('Want a signed card release? Bump firmware/lightweaver-controller/VERSION (and its pinned literal) in the same merge.');
}

let bundleVerdict = '';
if (!bundleOnly && lanes.firmware && cardBundleCheckRelevant(paths, false)) {
  // The firmware lane here comes only from Studio paths. CI drops it (no
  // signer, no VERSION bump, site deploys directly) when the canonical card
  // bundle provably matches the last signed release.
  if (process.argv.includes('--bundle-check')) {
    const printed = execFileSync('node', ['scripts/ci-card-bundle-check.mjs', '--print'], {
      encoding: 'utf8',
      env: { ...process.env, CI_BASE_SHA: mergeBase, CI_HEAD_SHA: 'HEAD' },
    }).trim();
    bundleVerdict = printed === 'true' ? 'unchanged' : 'changed';
    console.log(`Card bundle: ${bundleVerdict === 'unchanged'
      ? 'UNCHANGED — CI will skip the firmware signer; no VERSION bump needed (uncommitted changes not included in this proof)'
      : 'changed (or unprovable) — the firmware signer will run'}`);
  } else {
    console.log('Studio-only diff: CI skips the firmware signer when the card bundle is unchanged.');
    console.log('Prove it locally (~90s): node scripts/ci-preflight.mjs --bundle-check');
  }
}

if (lanes.firmware && !bundleOnly && bundleVerdict !== 'unchanged') {
  const previous = JSON.parse(
    readFileSync('lightweaver/public/firmware/release-manifest.json', 'utf8'),
  ).firmwareVersion;
  const current = readFileSync('firmware/lightweaver-controller/VERSION', 'utf8').trim();
  const left = versionNumbers(current);
  const right = versionNumbers(previous);
  const greater = left && right && (
    left[0] !== right[0] ? left[0] > right[0]
      : left[1] !== right[1] ? left[1] > right[1]
        : left[2] > right[2]
  );
  if (!greater) {
    // This exact moment — a finished change refused for want of a VERSION bump
    // — is when work gets deferred. Print the one command that parks it, so
    // deferring is cheaper than writing a paragraph nobody will find again.
    const branch = (() => {
      try { return git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { return '<your-branch>'; }
    })();
    problems.push(
      `firmware-sensitive change, but firmware/lightweaver-controller/VERSION (${current}) is not greater `
      + `than the already-signed ${previous}. Bump VERSION and the pinned literal in `
      + 'firmware/lightweaver-controller/tests/firmware-version-policy.mjs, or the signer will refuse the release.'
      + '\n\n  Not ready to publish a card update for this? Park it instead — push this branch, then:\n\n'
      + `    node scripts/firmware-queue.mjs add --branch ${branch} \\\n`
      + '      --what "<one plain sentence Adrian would understand>" \\\n'
      + '      --why "<one plain sentence saying why it is not worth a card update alone>"\n\n'
      + '  It is then carried automatically by the next card update. Commit the waiting-list\n'
      + '  change on a branch that is NOT firmware-sensitive, and open that as its own PR.',
    );
  } else {
    console.log(`Firmware VERSION ok: ${current} is publishable over signed ${previous}.`);
  }
}

// pages-staging scans these exact files; failing there costs a full CI round.
for (const file of ['lightweaver/src/lib/cardPushClient.js', 'lightweaver/src/v3/lw-flash.jsx']) {
  const text = readFileSync(file, 'utf8');
  if (/\/api\/library/.test(text)) {
    problems.push(`${file} references /api/library — card command and flashing paths must never traverse the cloud library API (pages-staging guard).`);
  }
  if (/led\.mandalacodes\.com\/design|\/design\//.test(text)) {
    problems.push(`${file} references the retired /design path (pages-staging guard).`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`\nPREFLIGHT FAIL: ${problem}`);
  process.exit(1);
}
console.log('Preflight clean — CI policy gates should not surprise you.');
