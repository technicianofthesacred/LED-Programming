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

export function classifyChangedPaths(paths, { conservative = false, generatedRelease = false } = {}) {
  if (conservative) return { ...ALL_LANES };
  if (generatedRelease && isGeneratedReleaseChange(paths)) {
    return { ...emptyLanes(), artifact: true };
  }
  const lanes = emptyLanes();

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
    ]) || path === 'firmware/lightweaver-controller/platformio.ini') {
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
      'release/production-job.schema.json',
      'scripts/build-firmware-manifest.mjs',
      'scripts/build-production-job.mjs',
      'scripts/rebuild-production-jobs.mjs',
      'scripts/sign-release-artifacts.mjs',
    ].includes(path)) {
      lanes.firmware = true;
      lanes.production = true;
      if (isPath(path, 'release/job-sources')) lanes.artifact = true;
      continue;
    }

    if (isPath(path, 'lightweaver/src/lib')) {
      lanes.source = true;
      lanes.browser = true;
      lanes.firmware = true;
      continue;
    }

    if (isPath(path, 'lightweaver/src')) {
      lanes.source = true;
      lanes.browser = true;
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
      'lightweaver/wrangler.toml',
      'lightweaver/wrangler.local.toml',
    ])) {
      lanes.source = true;
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

function writeOutputs(lanes, paths, outputPath, signedRelease = false) {
  if (!outputPath) return;
  const lines = [
    ...LANE_NAMES.map(name => `${name}=${lanes[name] ? 'true' : 'false'}`),
    `signed_release=${signedRelease ? 'true' : 'false'}`,
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
  });
  writeOutputs(lanes, resolved.paths, process.env.GITHUB_OUTPUT || '', signedRelease);
  process.stdout.write(`${JSON.stringify({ ...lanes, signedRelease, paths: resolved.paths, conservative: resolved.conservative })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
