import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyProductionReleaseSet } from '../src/lib/productionReleaseGate.js';
import { parseStudioBuildGraph } from '../src/lib/productionDeploymentCheck.js';
import { parseStudioRelease } from '../src/lib/studioRelease.js';
import { productionWranglerToml } from '../scripts/deploy-pages-production.mjs';
import {
  ProductionLibraryConfigurationError,
  readProductionLibraryConfiguration,
} from '../scripts/require-cloud-library-production.mjs';

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
const exhaustiveWorkflow = readFileSync(resolve(root, '../.github/workflows/exhaustive.yml'), 'utf8');
const setupDoc = readFileSync(resolve(root, '../docs/led-mandalacodes-setup.md'), 'utf8');
const todo = readFileSync(resolve(root, '../TODO.md'), 'utf8');
const runtimeRootReferences = [
  readFileSync(resolve(root, 'src/lib/cardPushClient.js'), 'utf8'),
  readFileSync(resolve(root, 'src/v3/lw-flash.jsx'), 'utf8'),
].join('\n');
const productionConfiguration = {
  LIGHTWEAVER_PRODUCTION_LIBRARY_READY: 'confirmed',
  PROJECTS_DB_DATABASE_ID: '123e4567-e89b-42d3-a456-426614174000',
  PROJECTS_DB_DATABASE_NAME: 'lightweaver-projects-production',
  PROJECT_BLOBS_BUCKET_NAME: 'lightweaver-project-blobs',
  MAX_LIBRARY_BODY_BYTES: '2097152',
  MAX_LIBRARY_BACKUP_BYTES: '4194304',
  MAX_LIBRARY_BACKUP_REVISIONS: '20',
};
const accessConfiguration = {
  ACCESS_TEAM_DOMAIN: 'https://mandalacodes.cloudflareaccess.com',
  ACCESS_AUD: 'a'.repeat(64),
  OWNER_EMAILS: 'owner@example.com',
};

function workflowRunScript(stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `workflow step must exist: ${stepName}`);
  const next = workflow.indexOf('\n      - ', start + marker.length);
  const step = workflow.slice(start, next < 0 ? workflow.length : next);
  const runMarker = '\n        run: |\n';
  const runStart = step.indexOf(runMarker);
  assert.ok(runStart >= 0, `${stepName} must use a testable multiline run block`);
  return step.slice(runStart + runMarker.length)
    .split('\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n')
    .trimEnd();
}

function runWorkflowScript(script, env = {}) {
  return spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${script}`], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}
const deploymentDocs = [
  readFileSync(resolve(root, '../docs/led-mandalacodes-setup.md'), 'utf8'),
  readFileSync(resolve(root, '../docs/deployment-checklist.md'), 'utf8'),
  readFileSync(resolve(root, '../docs/worker-flash-runbook.md'), 'utf8'),
].join('\n');
const deploymentChecklist = readFileSync(resolve(root, '../docs/deployment-checklist.md'), 'utf8');
const agentsDoc = readFileSync(resolve(root, '../AGENTS.md'), 'utf8');

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
assert.equal(pkg.scripts['test:studio-release'], 'node --test src/lib/studioRelease.test.js scripts/studio-release-identity.test.mjs scripts/studio-release-vite.test.mjs');
assert.match(pkg.scripts['launch:source'], /npm run test:build-graph/);
assert.match(pkg.scripts['launch:source'], /npm run test:studio-release/);
assert.match(pkg.scripts['test:projects'], /accountAuth\.test\.js/);
assert.match(pkg.scripts['test:projects'], /library-api\.test\.js/);
assert.equal(
  pkg.scripts['test:projects:browser'],
  'playwright test tests/cloud-project-library.spec.ts --project=chromium --workers=1',
);
assert.match(pkg.scripts['test:projects'], /tests\/cloud-bindings\.mjs/);
assert.match(pkg.scripts['launch:source'], /npm run test:projects && npm run test:projects:browser && npm run test:mapper/);
assert.equal(
  (pkg.scripts['launch:source'].match(/npm run test:cloud-bindings/g) || []).length,
  0,
  'test:projects already includes cloud bindings, so the full binding suite must not run twice',
);
assert.equal(
  (pkg.scripts['launch:source'].match(/npm run test:projects:browser/g) || []).length,
  1,
  'the focused account/library browser suite must run once in the launch gate',
);
assert.equal(pkg.scripts['test:screen-recovery'], 'playwright test tests/screen-recovery.spec.ts');
assert.equal(pkg.scripts['test:production'], 'playwright test tests/production-setup.spec.ts tests/production-physical-unmount.spec.ts --project=chromium --workers=1');
assert.match(pkg.scripts['launch:source'], /npm run test:prod-deploy && npm run test:build-graph && npm run test:studio-release && npm run test:show && npm run test:screen-recovery && npm run test:production/);
assert.match(pkg.scripts['launch:source'], /^npm run test:core:source/);
assert.equal(pkg.scripts['launch:check'], 'npm run launch:source && npm run firmware:check-bin');
assert.match(testWorkflow, /packages\/installer-core\/\*\*/);
assert.match(testWorkflow, /docs\/\*\*/);
assert.match(testWorkflow, /TODO\.md/);
assert.match(testWorkflow, /node scripts\/ci-changed-lanes\.mjs/);
assert.match(testWorkflow, /npm run ci:source-build/);
assert.match(testWorkflow, /npm run ci:browser-smoke/);
assert.doesNotMatch(testWorkflow, /npm run test:release-ui|--shard=/);
assert.match(pkg.scripts['ci:browser-smoke'], /npm run test:show/);
assert.match(pkg.scripts['ci:browser-smoke'], /npm run test:screen-recovery/);
assert.match(exhaustiveWorkflow, /npm run launch:check/);
assert.match(pkg.scripts['launch:source'], /npm run test:release-ui/);
assert.match(testWorkflow, /npm run ci:cloud/);
assert.match(testWorkflow, /npm run ci:production/);
assert.match(testWorkflow, /npm run ci:firmware-sensitive/);
assert.match(testWorkflow, /npm run ci:artifact/);
assert.doesNotMatch(testWorkflow, /npm run launch:(?:source|check)/);
assert.match(testWorkflow, /wrangler d1 migrations apply PROJECTS_DB[\s\S]*?--config wrangler\.local\.toml[\s\S]*?--local/);
assert.match(testWorkflow, /CI_BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.merge_group\.base_sha \|\| github\.event\.before \}\}/);
assert.match(testWorkflow, /CI_HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.event\.merge_group\.head_sha \|\| github\.sha \}\}/);
assert.match(testWorkflow, /needs: \[classify, source, browser, cloud, production, firmware, artifact\]/);
assert.match(testWorkflow, /if: \$\{\{ always\(\) \}\}/);
assert.match(testWorkflow, /if \[ "\$result" = "failure" \] \|\| \[ "\$result" = "cancelled" \]/);

assert.match(
  workflow,
  /workflow_run:\s*\n\s*workflows: \["Tests"\]\s*\n\s*types: \[completed\]\s*\n\s*branches: \[main\]/,
);
assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.workflow_run\.conclusion == 'success'/);
assert.match(workflow, /revision:\s*\n\s*description: Exact tested or signed main revision to deploy\s*\n\s*required: true/);
assert.match(workflow, /TESTED_REVISION:\s*\$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
assert.match(workflow, /Deploy revision must be a complete 40-character commit SHA/);
assert.ok(
  (workflow.match(/ref: \$\{\{ (?:steps\.revision|needs\.preflight)\.outputs\.revision \}\}/g) || []).length >= 2,
  'preflight and deploy must both check out the exact resolved revision',
);
assert.match(workflow, /CI_HEAD_SHA:\s*\$\{\{ steps\.revision\.outputs\.revision \}\}/);
assert.match(workflow, /Firmware-sensitive source is waiting for the protected signer/);
assert.match(workflow, /Signer artifact commits deploy only through their explicit signed-SHA dispatch/);
assert.match(workflow, /DEPLOY_REVISION:\s*\$\{\{ needs\.preflight\.outputs\.revision \}\}/);
assert.match(workflow, /npm run ci:artifact/);

const revisionRecheckStep = workflow.indexOf('- name: Reconfirm the exact main revision before publish');

const migrationStep = workflow.indexOf('- name: Apply additive production D1 migrations');
const deployStep = workflow.indexOf('- name: Build and deploy to Cloudflare Pages');
assert.ok(revisionRecheckStep >= 0 && revisionRecheckStep < migrationStep, 'origin/main must still name the exact revision before migration or upload');
assert.ok(migrationStep >= 0, 'production workflow must have an explicit remote migration step');
assert.ok(deployStep > migrationStep, 'additive D1 migrations must finish before compatible Functions deploy');
assert.equal(
  (workflow.slice(migrationStep, deployStep).match(/^\s*if:/gm) || []).length,
  1,
  'the migration step must have one unambiguous execution condition',
);
assert.match(workflow, /CLOUDFLARE_MIGRATION_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_MIGRATION_API_TOKEN \}\}/);
assert.match(workflow, /Apply additive production D1 migrations[\s\S]*?CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_MIGRATION_API_TOKEN \}\}/);
assert.match(workflow, /Build and deploy to Cloudflare Pages[\s\S]*?CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
assert.doesNotMatch(
  workflow.slice(deployStep),
  /CLOUDFLARE_API_TOKEN:\s*\$\{\{ secrets\.CLOUDFLARE_MIGRATION_API_TOKEN \}\}/,
  'the normal Pages deploy must not inherit the D1 migration credential',
);

const credentialScript = workflowRunScript('Check Cloudflare credentials');
assert.doesNotMatch(credentialScript, /\$\{\{/, 'untrusted GitHub contexts must enter the shell through quoted environment values');
assert.match(workflow, /EVENT_NAME:\s*\$\{\{ github\.event_name \}\}/);
assert.match(workflow, /DISPATCH_SOURCE:\s*\$\{\{ github\.event\.inputs\.source \|\| 'manual' \}\}/);
assert.match(workflow, /LIGHTWEAVER_NATIVE_AUTH_READY:\s*\$\{\{ vars\.LIGHTWEAVER_NATIVE_AUTH_READY \}\}/);

assert.throws(
  () => readProductionLibraryConfiguration(productionConfiguration),
  error => error instanceof ProductionLibraryConfigurationError
    && error.names.includes('ACCESS_TEAM_DOMAIN')
    && error.names.includes('ACCESS_AUD')
    && error.names.includes('OWNER_EMAILS'),
  'pre-cutover deployment must retain the Access runtime requirements',
);
const dualAuthConfiguration = readProductionLibraryConfiguration({
  ...productionConfiguration,
  ...accessConfiguration,
});
assert.equal(dualAuthConfiguration.LIGHTWEAVER_NATIVE_AUTH_READY, 'pending');
const nativeConfiguration = readProductionLibraryConfiguration({
  ...productionConfiguration,
  LIGHTWEAVER_NATIVE_AUTH_READY: 'confirmed',
});
assert.equal(nativeConfiguration.LIGHTWEAVER_NATIVE_AUTH_READY, 'confirmed');
const nativeToml = productionWranglerToml(nativeConfiguration);
assert.doesNotMatch(nativeToml, /^ACCESS_TEAM_DOMAIN\s*=/m);
assert.doesNotMatch(nativeToml, /^ACCESS_AUD\s*=/m);
assert.doesNotMatch(nativeToml, /^OWNER_EMAILS\s*=/m);

const injectionRoot = mkdtempSync(join(tmpdir(), 'lightweaver-workflow-injection-'));
try {
  const githubOutput = join(injectionRoot, 'github-output');
  const injectedPath = join(injectionRoot, 'injected');
  const injection = runWorkflowScript(credentialScript, {
    ACCESS_AUD: '',
    ACCESS_TEAM_DOMAIN: '',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_API_TOKEN: '',
    CLOUDFLARE_MIGRATION_API_TOKEN: '',
    DISPATCH_SOURCE: `ci\" ]; touch ${injectedPath}; #`,
    EVENT_NAME: 'workflow_dispatch',
    GITHUB_OUTPUT: githubOutput,
    LIGHTWEAVER_PREVIEW_ACCESS_READY: '',
    LIGHTWEAVER_NATIVE_AUTH_READY: '',
    LIGHTWEAVER_PRODUCTION_LIBRARY_READY: '',
    MAX_LIBRARY_BACKUP_BYTES: '',
    MAX_LIBRARY_BACKUP_REVISIONS: '',
    MAX_LIBRARY_BODY_BYTES: '',
    OWNER_EMAILS: '',
    PROJECTS_DB_DATABASE_ID: '',
    PROJECTS_DB_DATABASE_NAME: '',
    PROJECT_BLOBS_BUCKET_NAME: '',
  });
  assert.notEqual(injection.status, 0, 'a malicious manual source must not bypass the missing-configuration failure');
  assert.equal(existsSync(injectedPath), false, 'workflow_dispatch input must remain inert shell data');
} finally {
  rmSync(injectionRoot, { recursive: true, force: true });
}

const credentialBaseEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'account-id',
  CLOUDFLARE_API_TOKEN: 'pages-token',
  CLOUDFLARE_MIGRATION_API_TOKEN: 'migration-token',
  DISPATCH_SOURCE: 'ci',
  EVENT_NAME: 'push',
  ...productionConfiguration,
};
for (const [label, env] of [
  ['dual-auth', {
    ...credentialBaseEnv,
    ...accessConfiguration,
    LIGHTWEAVER_NATIVE_AUTH_READY: '',
    LIGHTWEAVER_PREVIEW_ACCESS_READY: 'confirmed',
  }],
  ['native-auth', {
    ...credentialBaseEnv,
    LIGHTWEAVER_NATIVE_AUTH_READY: 'confirmed',
    LIGHTWEAVER_PREVIEW_ACCESS_READY: '',
  }],
]) {
  const outputRoot = mkdtempSync(join(tmpdir(), `lightweaver-workflow-${label}-`));
  try {
    const githubOutput = join(outputRoot, 'github-output');
    const result = runWorkflowScript(credentialScript, { ...env, GITHUB_OUTPUT: githubOutput });
    assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);
    assert.match(readFileSync(githubOutput, 'utf8'), /^enabled=true$/m, `${label} production configuration must enable deploy`);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

const migrationScript = workflowRunScript('Apply additive production D1 migrations');
const migrationRoot = mkdtempSync(join(tmpdir(), 'lightweaver-workflow-migration-'));
try {
  const fakeBin = join(migrationRoot, 'bin');
  const recordPath = join(migrationRoot, 'migration-record.json');
  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  writeFileSync(fakeNpm, `#!/usr/bin/env node
const { readFileSync, statSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const configIndex = args.indexOf('--config');
const configPath = args[configIndex + 1];
writeFileSync(process.env.MIGRATION_RECORD, JSON.stringify({
  args,
  configPath,
  config: readFileSync(configPath, 'utf8'),
  mode: statSync(configPath).mode & 0o777,
}));
`);
  chmodSync(fakeNpm, 0o755);
  const migration = runWorkflowScript(migrationScript, {
    GITHUB_WORKSPACE: resolve(root, '..'),
    MIGRATION_RECORD: recordPath,
    PATH: `${fakeBin}:${process.env.PATH}`,
    PROJECTS_DB_DATABASE_ID: '123e4567-e89b-42d3-a456-426614174000',
    PROJECTS_DB_DATABASE_NAME: 'lightweaver-projects-production',
    RUNNER_TEMP: migrationRoot,
  });
  assert.equal(migration.status, 0, `${migration.stdout}\n${migration.stderr}`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.deepEqual(record.args, [
    'exec', '--', 'wrangler', 'd1', 'migrations', 'apply', 'PROJECTS_DB',
    '--config', record.configPath, '--remote',
  ]);
  assert.equal(record.mode, 0o600, 'generated production migration config must be owner-readable only');
  assert.match(record.config, /binding\s*=\s*"PROJECTS_DB"/);
  assert.match(record.config, /database_name\s*=\s*"lightweaver-projects-production"/);
  assert.match(record.config, /database_id\s*=\s*"123e4567-e89b-42d3-a456-426614174000"/);
  assert.match(record.config, new RegExp(`migrations_dir\\s*=\\s*${JSON.stringify(resolve(root, 'migrations')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(migrationScript, /0002_account_access\.sql/);
  assert.match(migrationScript, /0003_account_session_generation\.sql/);
  assert.equal(existsSync(record.configPath), false, 'temporary migration config must be removed after Wrangler exits');
} finally {
  rmSync(migrationRoot, { recursive: true, force: true });
}

const summaryScript = workflowRunScript('Record publish result');
const summaryRoot = mkdtempSync(join(tmpdir(), 'lightweaver-workflow-summary-'));
try {
  const summaryPath = join(summaryRoot, 'summary.md');
  const failedPublish = runWorkflowScript(summaryScript, {
    FRESHNESS_OUTCOME: 'skipped',
    GITHUB_STEP_SUMMARY: summaryPath,
    MIGRATION_OUTCOME: 'success',
    PUBLISH_ENABLED: 'true',
    PUBLISH_OUTCOME: 'failure',
  });
  assert.equal(failedPublish.status, 0, `${failedPublish.stdout}\n${failedPublish.stderr}`);
  const failedSummary = readFileSync(summaryPath, 'utf8');
  assert.match(failedSummary, /publish failed/i);
  assert.doesNotMatch(failedSummary, /live freshness check passed/i);
} finally {
  rmSync(summaryRoot, { recursive: true, force: true });
}

assert.doesNotMatch(redirects, /^\/design/m);
assert.match(redirects, /^\/visitor \/src\/visitor\/visitor\.html 200$/m);
assert.match(redirects, /^\/visitor\/ \/src\/visitor\/visitor\.html 200$/m);
assert.doesNotMatch(redirects, /^\/\*/m, 'a wildcard rewrite would keep /design alive as Studio');
assert.ok(existsSync(resolve(root, 'public/404.html')), 'a top-level 404 disables Pages implicit SPA fallback');

assert.match(index, /https:\/\/led\.mandalacodes\.com\/#screen=patterns/);
assert.doesNotMatch(index, /led\.mandalacodes\.com\/design/);
assert.match(freshness, /resolveProductionUrls\(process\.env\)/);
assert.match(freshness, /verifyStudioBuildGraph/);
assert.match(freshness, /verifyStudioRelease/);
assert.match(freshness, /\.pages\/lightweaver\/studio-build-graph\.json/);
assert.match(freshness, /\.pages\/lightweaver\/studio-release\.json/);
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
assert.match(setupDoc, /LIGHTWEAVER_NATIVE_AUTH_READY=confirmed/);
assert.match(setupDoc, /four account\/library includes/);
assert.match(setupDoc, /restore the Access application and exact-email policy/i);
assert.match(deploymentChecklist, /LIGHTWEAVER_NATIVE_AUTH_READY=confirmed/);
assert.match(deploymentChecklist, /Create owner account/);
assert.match(deploymentChecklist, /no public signup/i);
assert.match(deploymentChecklist, /restore the Access application\/policy/i);
assert.match(deploymentChecklist, /deploy the prior compatible Pages/i);
for (const term of ['Committed', 'Pushed', 'PR-ready', 'Merged', 'Deployed', 'Shipped']) {
  assert.match(agentsDoc, new RegExp(`\\*\\*${term}\\*\\*`));
  assert.match(deploymentChecklist, new RegExp(`\\*\\*${term}\\*\\*`));
}
for (const shippingContract of [agentsDoc, deploymentChecklist]) {
  assert.match(shippingContract, /ship it to main/i);
  assert.match(shippingContract, /origin\/main/);
  assert.match(shippingContract, /studio-release\.json/);
  assert.match(shippingContract, /exact (?:deployed )?files|every file/i);
  assert.match(shippingContract, /not shipped/i);
}
assert.doesNotMatch(runtimeRootReferences, /led\.mandalacodes\.com\/design|\/design\//);
assert.doesNotMatch(runtimeRootReferences, /\/api\/library/, 'card command and flashing paths must never traverse the cloud library API');
assert.deepEqual(routes, {
  version: 1,
  include: ['/api/account', '/api/account/*', '/api/library', '/api/library/*'],
  exclude: [],
});
assert.match(freshness, /LIGHTWEAVER_NATIVE_AUTH_READY/);
assert.match(freshness, /\/api\/account\/session/);
assert.match(freshness, /\/api\/account\/login/);
assert.match(freshness, /invalid_credentials/);
assert.match(freshness, /Invalid username or password\./);
assert.doesNotMatch(workflow, /LOGIN_PASSWORD|OWNER_PASSWORD|PBKDF2_PASSWORD/);
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
for (const required of [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_MIGRATION_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'LIGHTWEAVER_PREVIEW_ACCESS_READY',
  'LIGHTWEAVER_PRODUCTION_LIBRARY_READY',
  'PROJECTS_DB_DATABASE_ID',
  'PROJECTS_DB_DATABASE_NAME',
  'PROJECT_BLOBS_BUCKET_NAME',
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'OWNER_EMAILS',
  'MAX_LIBRARY_BODY_BYTES',
  'MAX_LIBRARY_BACKUP_BYTES',
  'MAX_LIBRARY_BACKUP_REVISIONS',
]) assert.match(setupDoc.slice(0, setupDoc.indexOf('## Current recommended setup')), new RegExp(required));
assert.match(setupDoc, /preview deployment URLs are public by default/i);
assert.match(setupDoc, /Enable\s+access\s+policy/);
assert.match(setupDoc, /preview Access application(?:'s)? audience/i);
assert.match(setupDoc, /LIGHTWEAVER_PREVIEW_ACCESS_READY=confirmed/);
assert.match(workflow, /LIGHTWEAVER_PREVIEW_ACCESS_READY:\s*\$\{\{ vars\.LIGHTWEAVER_PREVIEW_ACCESS_READY \}\}/);
assert.doesNotMatch(setupDoc, /d1 migrations apply lightweaver-projects-(?:preview|production) --remote/);
assert.match(setupDoc, /d1 migrations apply PROJECTS_DB --config \.wrangler\/deploy\/lightweaver-preview\.toml --remote/);
assert.doesNotMatch(todo, /this repo deploys only to the `studio` Pages preview branch/);
assert.doesNotMatch(todo, /production at led\.mandalacodes\.com ships from the mandalacodes repo/);
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
  const stagedReleasePath = resolve(stagedRoot, 'studio-release.json');
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
  assert.ok(existsSync(stagedReleasePath), 'staged Studio release marker must exist');
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
  const stagedRelease = parseStudioRelease(readFileSync(stagedReleasePath, 'utf8'));
  assert.equal(stagedRelease.buildId, stagedRelease.sourceRevision.slice(0, 12));
  // The human-facing build number must be published alongside the revision, or
  // the footer beacon has nothing comparable to show.
  assert.ok(Number.isSafeInteger(stagedRelease.buildNumber) && stagedRelease.buildNumber >= 1);
  const stagedCodePaths = readdirSync(resolve(stagedRoot, 'assets'), { recursive: true })
    .map(path => `assets/${String(path).split(sep).join('/')}`)
    .filter(path => /\.(?:js|css)$/.test(path))
    .sort();
  assert.deepEqual(
    stagedGraph.files.map(file => file.path),
    [...stagedCodePaths, 'index.html', 'studio-release.json'].sort(),
    'staged graph must cover index.html, the release marker, and every staged Vite JS/CSS asset exactly',
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
