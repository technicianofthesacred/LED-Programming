#!/usr/bin/env node
// Regenerate every production-job source against the CURRENT signed firmware
// manifest, then rebuild every job artifact + the same-origin index.
//
// Jobs pin the exact signed firmware buildId, so they MUST be rebuilt whenever
// a new firmware release is signed — the protected build-firmware workflow
// runs this right after signing and commits the results atomically with the
// release. Run locally after adding a new generator:
//
//   node scripts/rebuild-production-jobs.mjs
//
// Add an artwork by dropping a generator into release/job-generators/ (copy
// bench-fixture-44.mjs and change the layout/identity), never by hand-editing
// release/job-sources/.
import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatorsDir = resolve(repoRoot, 'release/job-generators');
const sourcesDir = resolve(repoRoot, 'release/job-sources');

const generators = (await readdir(generatorsDir)).filter(name => name.endsWith('.mjs')).sort();
if (!generators.length) throw new Error('No production-job generators found in release/job-generators');
for (const name of generators) {
  execFileSync(process.execPath, [resolve(generatorsDir, name)], { stdio: 'inherit', cwd: repoRoot });
}

const sources = (await readdir(sourcesDir)).filter(name => name.endsWith('.json')).sort();
if (!sources.length) throw new Error('Generators produced no job sources in release/job-sources');
for (const name of sources) {
  execFileSync(process.execPath, [
    resolve(repoRoot, 'scripts/build-production-job.mjs'),
    '--input', resolve(sourcesDir, name),
  ], { stdio: 'inherit', cwd: repoRoot });
}
console.log(`Rebuilt ${sources.length} production job(s) from ${generators.length} generator(s).`);
