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
assert.match(platformio, /extra_scripts\s*=\s*[\s\S]*pre:scripts\/inject-build-identity\.py/);
assert.match(workflow, /LW_BUILD_ID:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
assert.match(workflow, /SOURCE_REVISION:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
assert.match(workflow, /LW_BUILD_ID:\s*\$\{\{ env\.SOURCE_REVISION \}\}/);
assert.match(workflow, /--build-id "\$SOURCE_REVISION"/);
assert.match(workflow, /--source-revision "\$SOURCE_REVISION"/);
// Both the compiled binary and the signed manifest take their build number
// from the same source revision, so a card and the published release always
// agree on the number the owner compares.
assert.match(workflow, /LW_BUILD_NUMBER:\s*\$\{\{ needs\.classify\.outputs\.build_number \}\}/);
assert.match(workflow, /LW_BUILD_NUMBER:\s*\$\{\{ env\.BUILD_NUMBER \}\}/);
assert.match(workflow, /--build-number "\$BUILD_NUMBER"/);
assert.match(
  workflow,
  /'firmware\/lightweaver-controller\/scripts\/\*\*'/,
  'every firmware build middleware change must trigger a fresh signed release',
);

console.log('release-build-identity tests passed');
