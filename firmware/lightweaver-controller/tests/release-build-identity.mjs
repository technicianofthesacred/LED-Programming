import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../..');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'lightweaver/public/firmware/release-manifest.json'), 'utf8'));
const image = readFileSync(resolve(repoRoot, 'lightweaver/public', manifest.image.url.slice(1)));
const platformio = readFileSync(resolve(repoRoot, 'firmware/lightweaver-controller/platformio.ini'), 'utf8');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');

assert.match(manifest.buildId, /^[a-f0-9]{40}$/);
assert.equal(manifest.provenance.sourceRevision, manifest.buildId);
assert.ok(image.includes(Buffer.from(manifest.buildId)), 'factory image must contain the exact signed manifest build ID');
assert.match(platformio, /extra_scripts = pre:scripts\/inject-build-identity\.py/);
assert.match(workflow, /LW_BUILD_ID:\s*\$\{\{ github\.sha \}\}/);
assert.match(workflow, /--build-id "\$\{GITHUB_SHA\}"/);

console.log('release-build-identity tests passed');
