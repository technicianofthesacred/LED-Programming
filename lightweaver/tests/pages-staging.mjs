import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { verifyProductionReleaseSet } from '../src/lib/productionReleaseGate.js';
import { parseStudioBuildGraph } from '../src/lib/productionDeploymentCheck.js';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const redirects = readFileSync(resolve(root, 'public/_redirects'), 'utf8');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const freshness = readFileSync(resolve(root, 'scripts/check-prod-freshness.mjs'), 'utf8');
const deploymentCheck = readFileSync(resolve(root, 'src/lib/productionDeploymentCheck.js'), 'utf8');
const headers = readFileSync(resolve(root, 'public/_headers'), 'utf8');
const routes = JSON.parse(readFileSync(resolve(root, 'public/_routes.json'), 'utf8'));
const workflow = readFileSync(resolve(root, '../.github/workflows/deploy-site.yml'), 'utf8');
const testWorkflow = readFileSync(resolve(root, '../.github/workflows/test.yml'), 'utf8');
const setupDoc = readFileSync(resolve(root, '../docs/led-mandalacodes-setup.md'), 'utf8');
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
assert.match(pkg.scripts['stage:pages'], /^npm run build:functions && /);
assert.match(pkg.scripts['stage:pages'], /cp -R dist\/. \.pages\/lightweaver\//);
assert.match(pkg.scripts['stage:pages'], /generate-studio-build-graph\.mjs \.pages\/lightweaver$/);
assert.doesNotMatch(pkg.scripts['stage:pages'], /lightweaver\/design/);
assert.equal(pkg.scripts['verify:pages'], 'node tests/pages-staging.mjs --artifact');
assert.match(pkg.scripts['launch:source'], /npm run build && npm run stage:pages && npm run verify:pages$/);
assert.equal(pkg.scripts['deploy:pages'], 'node scripts/deploy-pages-production.mjs');
assert.equal(pkg.scripts['pages:project'], 'wrangler pages project create lightweaver --production-branch main');
assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
assert.equal(lock.packages[''].devDependencies.wrangler, pkg.devDependencies.wrangler);
assert.doesNotMatch(JSON.stringify(pkg.scripts), /npx --yes wrangler/);
assert.match(pkg.scripts['test:core'], /pages-headers\.mjs && node tests\/pages-staging\.mjs/);
assert.equal(pkg.scripts['test:prod-deploy'], 'node --test src/lib/productionDeploymentCheck.test.js src/lib/productionReleaseGate.test.js');
assert.equal(pkg.scripts['test:build-graph'], 'node --test scripts/generate-studio-build-graph.test.mjs');
assert.match(pkg.scripts['launch:source'], /npm run test:build-graph/);
assert.match(pkg.scripts['launch:source'], /npm run test:projects && npm run test:cloud-bindings/);
assert.equal(pkg.scripts['test:screen-recovery'], 'playwright test tests/screen-recovery.spec.ts');
assert.equal(pkg.scripts['test:production'], 'playwright test tests/production-setup.spec.ts tests/production-physical-unmount.spec.ts --project=chromium --workers=1');
assert.match(pkg.scripts['launch:source'], /npm run test:prod-deploy && npm run test:build-graph && npm run test:show && npm run test:screen-recovery && npm run test:production/);
assert.match(pkg.scripts['launch:source'], /^npm run test:core:source/);
assert.equal(pkg.scripts['launch:check'], 'npm run launch:source && npm run firmware:check-bin');
assert.match(testWorkflow, /packages\/installer-core\/\*\*/);
assert.match(testWorkflow, /docs\/led-mandalacodes-setup\.md/);
assert.match(testWorkflow, /TODO\.md/);
assert.match(testWorkflow, /npm run launch:source/);
assert.match(testWorkflow, /npm run launch:check/);
assert.match(testWorkflow, /wrangler d1 migrations apply PROJECTS_DB[\s\S]*?--config wrangler\.local\.toml[\s\S]*?--local/);
assert.match(testWorkflow, /github\.ref != 'refs\/heads\/main'/);
assert.match(testWorkflow, /github\.ref == 'refs\/heads\/main'/);

const migrationStep = workflow.indexOf('- name: Apply additive production D1 migrations');
const deployStep = workflow.indexOf('- name: Build and deploy to Cloudflare Pages');
assert.ok(migrationStep >= 0, 'production workflow must have an explicit remote migration step');
assert.ok(deployStep > migrationStep, 'additive D1 migrations must finish before compatible Functions deploy');
assert.match(workflow, /CLOUDFLARE_MIGRATION_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_MIGRATION_API_TOKEN \}\}/);
assert.match(workflow, /Apply additive production D1 migrations[\s\S]*?CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_MIGRATION_API_TOKEN \}\}/);
assert.match(workflow, /Build and deploy to Cloudflare Pages[\s\S]*?CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
assert.match(workflow, /wrangler d1 migrations apply "\$PROJECTS_DB_DATABASE_NAME" --remote/);
assert.doesNotMatch(
  workflow.slice(deployStep),
  /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_MIGRATION_API_TOKEN \}\}/,
  'the normal Pages deploy must not inherit the D1 migration credential',
);

assert.doesNotMatch(redirects, /^\/design/m);
assert.match(redirects, /^\/visitor \/src\/visitor\/visitor\.html 200$/m);
assert.match(redirects, /^\/visitor\/ \/src\/visitor\/visitor\.html 200$/m);
assert.doesNotMatch(redirects, /^\/\*/m, 'a wildcard rewrite would keep /design alive as Studio');
assert.ok(existsSync(resolve(root, 'public/404.html')), 'a top-level 404 disables Pages implicit SPA fallback');

assert.match(index, /https:\/\/led\.mandalacodes\.com\/#screen=patterns/);
assert.doesNotMatch(index, /led\.mandalacodes\.com\/design/);
assert.match(freshness, /resolveProductionUrls\(process\.env\)/);
assert.match(freshness, /verifyStudioBuildGraph/);
assert.match(freshness, /\.pages\/lightweaver\/studio-build-graph\.json/);
assert.match(freshness, /npm run build && npm run stage:pages/);
assert.match(freshness, /verifyStudioBuildGraph\(productionFetch, webcrypto, studioBuildGraphUrl, expectedStudioGraph, studioRootBytes\)/);
assert.match(freshness, /studioResponse = await fetch\(studioUrl, \{[\s\S]*?redirect: 'manual'/);
assert.doesNotMatch(freshness, /studioResponse = await fetch\(studioUrl, \{[\s\S]*?redirect: 'follow'/);
assert.doesNotMatch(freshness, /loadProductionFirmwareRelease\(productionFetch, webcrypto, \{/, 'production smoke must not override the pinned relative firmware release paths');
assert.match(deploymentCheck, /https:\/\/led\.mandalacodes\.com/);
assert.match(deploymentCheck, /\/design/);
assert.match(deploymentCheck, /\/firmware\/lightweaver-controller-esp32s3-factory\.bin/);
assert.match(deploymentCheck, /#screen=production/);
assert.match(deploymentCheck, /\/production\/jobs\/index\.json/);
assert.match(deploymentCheck, /\/firmware\/release-provenance\.json/);
assert.match(deploymentCheck, /expected HTTP 404/);
assert.doesNotMatch(workflow, /\/design\/?/);
assert.match(workflow, /node-version: '22'/);
assert.doesNotMatch(workflow, /node-version: '20'/);
assert.match(testWorkflow, /node-version: '22'/);
assert.doesNotMatch(testWorkflow, /node-version: '20'/);
assert.doesNotMatch(deploymentDocs, /led\.mandalacodes\.com\/design\/?#|led\.mandalacodes\.com\/design[^\n]*opens Studio/);
assert.match(setupDoc, /Wrangler is pinned/);
assert.match(setupDoc, /PROD_ORIGIN/);
assert.doesNotMatch(runtimeRootReferences, /led\.mandalacodes\.com\/design|\/design\//);
assert.doesNotMatch(runtimeRootReferences, /\/api\/library/, 'card command and flashing paths must never traverse the cloud library API');
assert.deepEqual(routes, {
  version: 1,
  include: ['/api/library', '/api/library/*'],
  exclude: [],
});
assert.match(freshness, /\/api\/library\/session/);
assert.match(freshness, /libraryResponse\.headers\.get\('cache-control'\)/);
assert.match(freshness, /unauthenticated library request/i);
assert.match(setupDoc, /lightweaver-projects-preview/);
assert.match(setupDoc, /lightweaver-projects-production/);
assert.match(setupDoc, /CLOUDFLARE_MIGRATION_API_TOKEN/);
assert.match(setupDoc, /D1 (?:Edit|Write) only/);
assert.match(setupDoc, /led\.mandalacodes\.com\/api\/library\*/);
assert.match(setupDoc, /exact email/i);
assert.match(setupDoc, /\/cdn-cgi\/access\/logout/);
assert.match(headers, /\/production\/jobs\/index\.json\n  Cache-Control: no-store/);
assert.match(headers, /\/studio-build-graph\.json\n  Cache-Control: no-store/);
assert.match(headers, /\/production\/jobs\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
assert.ok(headers.indexOf('/production/jobs/index.json') > headers.indexOf('/production/jobs/*'), 'exact mutable job index header must override the immutable wildcard');

if (process.argv.includes('--artifact')) {
  const stagedRoot = resolve(root, '.pages/lightweaver');
  const stagedIndexPath = resolve(stagedRoot, 'index.html');
  const stagedRedirectsPath = resolve(stagedRoot, '_redirects');
  const stagedHeadersPath = resolve(stagedRoot, '_headers');
  const stagedRoutesPath = resolve(stagedRoot, '_routes.json');
  const stagedNotFoundPath = resolve(stagedRoot, '404.html');
  const stagedFirmwarePath = resolve(stagedRoot, 'firmware/lightweaver-controller-esp32s3-factory.bin');
  const stagedJobIndexPath = resolve(stagedRoot, 'production/jobs/index.json');
  const stagedGraphPath = resolve(stagedRoot, 'studio-build-graph.json');
  const compiledFunctionPath = resolve(root, '.pages/functions-build/index.js');
  const compiledFunctionRoutesPath = resolve(root, '.pages/functions-build/_routes.json');

  assert.ok(existsSync(stagedIndexPath), 'staged root index.html must exist');
  assert.ok(existsSync(stagedRedirectsPath), 'staged root redirects must exist');
  assert.ok(existsSync(stagedHeadersPath), 'staged root headers must exist');
  assert.ok(existsSync(stagedRoutesPath), 'staged root Function routes must exist');
  assert.ok(existsSync(stagedNotFoundPath), 'staged top-level 404.html must exist');
  assert.ok(existsSync(stagedFirmwarePath), 'staged root factory firmware must exist');
  assert.ok(existsSync(stagedJobIndexPath), 'staged production job index must exist');
  assert.ok(existsSync(stagedGraphPath), 'staged Studio build graph must exist');
  assert.ok(existsSync(compiledFunctionPath), 'staging must compile the Pages Function');
  assert.ok(existsSync(compiledFunctionRoutesPath), 'Functions compilation must emit its route manifest');
  assert.ok(!existsSync(resolve(stagedRoot, 'design')), 'staged artifact must not contain a design directory');

  const stagedIndex = readFileSync(stagedIndexPath, 'utf8');
  const stagedRedirects = readFileSync(stagedRedirectsPath, 'utf8');
  const stagedHeaders = readFileSync(stagedHeadersPath, 'utf8');
  const stagedRoutes = JSON.parse(readFileSync(stagedRoutesPath, 'utf8'));
  assert.match(stagedIndex, /(?:src|href)="\/assets\//, 'built asset URLs must be rooted at /assets');
  assert.doesNotMatch(stagedIndex, /(?:src|href)="\/design\//, 'built asset URLs must not use the removed mount');
  assert.equal(stagedRedirects, redirects, 'staging must preserve the root redirect contract from public');
  assert.equal(stagedHeaders, headers, 'staging must preserve the production cache and security header contract from public');
  assert.deepEqual(stagedRoutes, routes, 'staging must invoke Functions only for the private library API');

  const stagedGraph = parseStudioBuildGraph(readFileSync(stagedGraphPath, 'utf8'));
  const stagedCodePaths = readdirSync(resolve(stagedRoot, 'assets'), { recursive: true })
    .map(path => `assets/${String(path).split(sep).join('/')}`)
    .filter(path => /\.(?:js|css)$/.test(path))
    .sort();
  assert.deepEqual(
    stagedGraph.files.map(file => file.path),
    [...stagedCodePaths, 'index.html'].sort(),
    'staged graph must cover index.html and every staged Vite JS/CSS asset exactly',
  );
  for (const expected of stagedGraph.files) {
    const bytes = readFileSync(resolve(stagedRoot, expected.path));
    assert.equal(bytes.byteLength, expected.bytes, `${expected.path} byte size must match staged bytes`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${expected.path} hash must match staged bytes`);
  }

  const stagedFetch = async input => {
    const pathname = decodeURIComponent(new URL(String(input), 'https://staged.lightweaver.invalid').pathname);
    const candidate = resolve(stagedRoot, `.${pathname}`);
    assert.ok(candidate.startsWith(`${stagedRoot}${sep}`), `staged release path escaped artifact root: ${pathname}`);
    if (!existsSync(candidate)) return new Response('Not found', { status: 404 });
    const bytes = readFileSync(candidate);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  };
  const verified = await verifyProductionReleaseSet(stagedFetch, webcrypto);
  assert.equal(verified.jobs.length, verified.jobIndex.jobs.length, 'every staged production job index entry must load and verify');
}

console.log('pages-staging tests passed');
