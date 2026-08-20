import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LANE_NAMES = Object.freeze([
  'source',
  'browser',
  'cloud',
  'production',
  'firmware',
  'artifact',
]);

const ALL_LANES = Object.freeze(Object.fromEntries(LANE_NAMES.map(name => [name, true])));
const GENERATED_RELEASE_PATHS = Object.freeze([
  'lightweaver/public/firmware',
  'lightweaver/public/production/jobs',
  'release/job-sources',
  'firmware/lightweaver-controller/src/LightweaverCardStudioBundle.h',
]);

const isPath = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
const isAnyPath = (path, prefixes) => prefixes.some(prefix => isPath(path, prefix));

export function isGeneratedReleaseChange(paths) {
  return paths.length > 0
    && paths.every(path => isAnyPath(String(path).replace(/^\.\//, ''), GENERATED_RELEASE_PATHS));
}

function emptyLanes() {
  return Object.fromEntries(LANE_NAMES.map(name => [name, false]));
}

// cardBundleUnchanged: a verified byte-level fact, never a guess — the
// canonical card-Studio bundle built from this revision hashed identical to
// the one recorded by the last protected signer run (scripts/
// ci-card-bundle-check.mjs). Studio source is embedded in the card firmware,
// so Studio paths normally select the firmware lane; when the embedded bundle
// provably did not change, that selection is dropped and the change ships as
// a site-only deploy. Hard firmware paths (firmware/, release machinery,
// installer-core) are never dropped, and the conservative everything-runs
// answer is never weakened.
export function classifyChangedPaths(paths, {
  conservative = false,
  generatedRelease = false,
  cardBundleUnchanged = false,
} = {}) {
  if (conservative) return { ...ALL_LANES };
  if (generatedRelease && isGeneratedReleaseChange(paths)) {
    return { ...emptyLanes(), artifact: true };
  }
  const lanes = emptyLanes();
  const studioFirmware = !cardBundleUnchanged;

  for (const rawPath of paths || []) {
    const path = String(rawPath || '').trim().replace(/^\.\//, '');
    if (!path) continue;

    if (isPath(path, '.github/workflows')
      || path === 'scripts/ci-changed-lanes.mjs'
      || path === 'scripts/ci-changed-lanes.test.mjs'
      || path === 'lightweaver/package.json'
      || path === 'lightweaver/package-lock.json') {
      Object.assign(lanes, ALL_LANES);
      continue;
    }

    if (isAnyPath(path, [
      'lightweaver/public/firmware',
      'lightweaver/public/production/jobs',
    ])) {
      lanes.artifact = true;
      continue;
    }

    if (isAnyPath(path, [
      'firmware/lightweaver-controller/src',
      'firmware/lightweaver-controller/scripts',
    ]) || /^firmware\/lightweaver-controller\/tests\/firmware-(?:update|boot-health)(?:\.|-)/.test(path) || [
      'firmware/lightweaver-controller/VERSION',
      'firmware/lightweaver-controller/platformio.ini',
    ].includes(path)) {
      lanes.firmware = true;
      lanes.production = true;
      continue;
    }

    if (isAnyPath(path, [
      'packages/installer-core',
      'release/job-generators',
      'release/job-sources',
      'release/keys',
    ]) || [
      'release/firmware-manifest.schema.json',
      'release/firmware-update-ticket.schema.json',
      'release/production-job.schema.json',
      'scripts/build-firmware-manifest.mjs',
      'scripts/build-firmware-update-ticket.mjs',
      'scripts/build-production-job.mjs',
      'scripts/firmware-update-release.test.mjs',
      'scripts/rebuild-production-jobs.mjs',
      'scripts/sign-release-artifacts.mjs',
      'scripts/verify-production-artifacts.mjs',
    ].includes(path)) {
      lanes.firmware = true;
      lanes.production = true;
      if (isPath(path, 'release/job-sources')) lanes.artifact = true;
      continue;
    }

    if (isPath(path, 'lightweaver/src/lib')) {
      lanes.source = true;
      lanes.browser = true;
      if (studioFirmware) lanes.firmware = true;
      continue;
    }

    if (isPath(path, 'lightweaver/src')) {
      lanes.source = true;
      lanes.browser = true;
      if (studioFirmware) lanes.firmware = true;
      continue;
    }

    if (isAnyPath(path, [
      'lightweaver/functions',
      'lightweaver/migrations',
    ]) || /(?:^|\/)cloud-|(?:^|\/)library-/.test(path)) {
      lanes.source = true;
      lanes.cloud = true;
      continue;
    }

    if (/^lightweaver\/tests\/production(?:-|\.)/.test(path)) {
      lanes.source = true;
      lanes.production = true;
      continue;
    }

    if (isPath(path, 'lightweaver/tests')) {
      lanes.source = true;
      lanes.browser = true;
      continue;
    }

    if (isAnyPath(path, [
      'lightweaver/scripts',
      'led-art-mapper',
    ]) || isAnyPath(path, [
      'lightweaver/vite.config.js',
      'lightweaver/index.html',
      'lightweaver/card.html',
      'lightweaver/wrangler.toml',
      'lightweaver/wrangler.local.toml',
    ])) {
      lanes.source = true;
      if ((isPath(path, 'lightweaver/scripts') || path === 'lightweaver/vite.config.js' || path === 'lightweaver/card.html')
        && studioFirmware) {
        lanes.firmware = true;
      }
      continue;
    }

    // Documentation and any new, unclassified release-surface path still run
    // the bounded source lane. New paths must never silently receive no checks.
    lanes.source = true;
  }

  return lanes;
}

function gitChangedPaths(base, head, cwd = process.cwd()) {
  const output = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMRD', base, head], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

export function resolveChangedPaths({
  explicitPaths = [],
  before = '',
  head = '',
  cwd = process.cwd(),
} = {}) {
  const paths = explicitPaths.map(value => String(value || '').trim()).filter(Boolean);
  if (paths.length > 0) return { paths, conservative: false };
  if (!before || !head || /^0{40}$/.test(before)) return { paths: [], conservative: true };
  return { paths: gitChangedPaths(before, head, cwd), conservative: false };
}

function parseArguments(argv) {
  const parsed = { explicitPaths: [], before: '', head: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base') parsed.before = argv[++index] || '';
    else if (argument === '--head') parsed.head = argv[++index] || '';
    else if (argument === '--path') parsed.explicitPaths.push(argv[++index] || '');
    else parsed.explicitPaths.push(argument);
  }
  return parsed;
}

// Does the firmware lane fire ONLY because Studio source is embedded in the
// card bundle — with no hard firmware path touched at all?
//
// This is the difference between "the card's behaviour changed" and "the
// card's built-in copy of the browser interface drifted". The first must
// produce a signed release. The second must not: it would mean every colour
// tweak mints a card release, bumps a version, and holds the website behind
// twenty minutes of signing for a change no card is waiting on. Bundle drift
// accumulates harmlessly and ships with the next release, which a VERSION bump
// (a hard firmware path) triggers on demand.
//
// The firmware TEST lane is unaffected — Studio changes still compile against
// the card, so a bundle that no longer fits is caught on the pull request
// rather than twenty minutes into a release.
export function firmwareBundleOnly(paths, {
  conservative = false,
  generatedRelease = false,
} = {}) {
  if (conservative) return false;
  const options = { conservative, generatedRelease };
  const withBundle = classifyChangedPaths(paths, { ...options, cardBundleUnchanged: false });
  if (!withBundle.firmware) return false;
  return classifyChangedPaths(paths, { ...options, cardBundleUnchanged: true }).firmware === false;
}

function writeOutputs(lanes, paths, outputPath, signedRelease = false, bundleOnly = false) {
  if (!outputPath) return;
  const lines = [
    ...LANE_NAMES.map(name => `${name}=${lanes[name] ? 'true' : 'false'}`),
    `signed_release=${signedRelease ? 'true' : 'false'}`,
    `firmware_bundle_only=${bundleOnly ? 'true' : 'false'}`,
    `changed_paths=${JSON.stringify(paths)}`,
  ];
  appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const resolved = resolveChangedPaths({
    ...parsed,
    before: parsed.before || process.env.CI_BASE_SHA || '',
    head: parsed.head || process.env.CI_HEAD_SHA || '',
  });
  const signedRelease = process.env.CI_GENERATED_RELEASE === 'true'
    && isGeneratedReleaseChange(resolved.paths);
  const lanes = classifyChangedPaths(resolved.paths, {
    conservative: resolved.conservative,
    generatedRelease: signedRelease,
    // Set only by scripts/ci-card-bundle-check.mjs after a byte-level match of
    // the canonical card bundle against the last signed release; anything
    // short of that leaves it unset and classification stays fail-closed.
    cardBundleUnchanged: process.env.CI_CARD_BUNDLE_UNCHANGED === 'true',
  });
  const bundleOnly = firmwareBundleOnly(resolved.paths, {
    conservative: resolved.conservative,
    generatedRelease: signedRelease,
  });
  writeOutputs(lanes, resolved.paths, process.env.GITHUB_OUTPUT || '', signedRelease, bundleOnly);
  process.stdout.write(`${JSON.stringify({ ...lanes, signedRelease, firmwareBundleOnly: bundleOnly, paths: resolved.paths, conservative: resolved.conservative })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
