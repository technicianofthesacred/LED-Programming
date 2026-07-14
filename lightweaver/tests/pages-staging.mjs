import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const redirects = readFileSync(resolve(root, 'public/_redirects'), 'utf8');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const freshness = readFileSync(resolve(root, 'scripts/check-prod-freshness.mjs'), 'utf8');
const workflow = readFileSync(resolve(root, '../.github/workflows/deploy-site.yml'), 'utf8');
const runtimeRootReferences = [
  readFileSync(resolve(root, 'src/lib/cardPushClient.js'), 'utf8'),
  readFileSync(resolve(root, 'src/v3/lw-flash.jsx'), 'utf8'),
].join('\n');
const deploymentDocs = [
  readFileSync(resolve(root, '../docs/led-mandalacodes-setup.md'), 'utf8'),
  readFileSync(resolve(root, '../docs/deployment-checklist.md'), 'utf8'),
  readFileSync(resolve(root, '../docs/worker-flash-runbook.md'), 'utf8'),
].join('\n');

assert.equal(pkg.scripts['build:design'], undefined);
assert.match(pkg.scripts['stage:pages'], /cp -R dist\/. \.pages\/lightweaver\//);
assert.doesNotMatch(pkg.scripts['stage:pages'], /lightweaver\/design/);
assert.equal(pkg.scripts['deploy:pages'], 'npm run build && npm run stage:pages && npx --yes wrangler pages deploy .pages/lightweaver --project-name lightweaver --branch main');
assert.match(pkg.scripts['test:core'], /pages-headers\.mjs && node tests\/pages-staging\.mjs/);

assert.doesNotMatch(redirects, /^\/design/m);
assert.match(redirects, /^\/visitor \/src\/visitor\/visitor\.html 200$/m);
assert.match(redirects, /^\/visitor\/ \/src\/visitor\/visitor\.html 200$/m);
assert.doesNotMatch(redirects, /^\/\*/m, 'a wildcard rewrite would keep /design alive as Studio');
assert.ok(existsSync(resolve(root, 'public/404.html')), 'a top-level 404 disables Pages implicit SPA fallback');

assert.match(index, /https:\/\/led\.mandalacodes\.com\/#screen=patterns/);
assert.doesNotMatch(index, /led\.mandalacodes\.com\/design/);
assert.match(freshness, /https:\/\/led\.mandalacodes\.com\/firmware\/lightweaver-controller-esp32s3-factory\.bin/);
assert.match(freshness, /https:\/\/led\.mandalacodes\.com\//);
assert.match(freshness, /https:\/\/led\.mandalacodes\.com\/design/);
assert.match(freshness, /Legacy Studio route is still live/);
assert.doesNotMatch(workflow, /\/design\/?/);
assert.doesNotMatch(deploymentDocs, /led\.mandalacodes\.com\/design/);
assert.doesNotMatch(runtimeRootReferences, /led\.mandalacodes\.com\/design|\/design\//);

if (process.argv.includes('--artifact')) {
  const stagedRoot = resolve(root, '.pages/lightweaver');
  const stagedIndexPath = resolve(stagedRoot, 'index.html');
  const stagedRedirectsPath = resolve(stagedRoot, '_redirects');
  const stagedNotFoundPath = resolve(stagedRoot, '404.html');
  const stagedFirmwarePath = resolve(stagedRoot, 'firmware/lightweaver-controller-esp32s3-factory.bin');

  assert.ok(existsSync(stagedIndexPath), 'staged root index.html must exist');
  assert.ok(existsSync(stagedRedirectsPath), 'staged root redirects must exist');
  assert.ok(existsSync(stagedNotFoundPath), 'staged top-level 404.html must exist');
  assert.ok(existsSync(stagedFirmwarePath), 'staged root factory firmware must exist');
  assert.ok(!existsSync(resolve(stagedRoot, 'design')), 'staged artifact must not contain a design directory');

  const stagedIndex = readFileSync(stagedIndexPath, 'utf8');
  const stagedRedirects = readFileSync(stagedRedirectsPath, 'utf8');
  assert.match(stagedIndex, /(?:src|href)="\/assets\//, 'built asset URLs must be rooted at /assets');
  assert.doesNotMatch(stagedIndex, /(?:src|href)="\/design\//, 'built asset URLs must not use the removed mount');
  assert.equal(stagedRedirects, redirects, 'staging must preserve the root redirect contract from public');
}

console.log('pages-staging tests passed');
