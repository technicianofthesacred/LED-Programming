import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../src');
const repositoryHeaderPath = resolve(root, 'LightweaverProjectRepository.h');
const repositorySourcePath = resolve(root, 'LightweaverProjectRepository.cpp');
assert.ok(existsSync(repositoryHeaderPath) && existsSync(repositorySourcePath),
  'bounded card project repository firmware module must exist');
const header = readFileSync(repositoryHeaderPath, 'utf8');
const source = readFileSync(repositorySourcePath, 'utf8');
const web = readFileSync(resolve(root, 'LightweaverWeb.cpp'), 'utf8');

for (const operation of ['list', 'read', 'preflight', 'begin', 'chunk', 'commit', 'delete']) {
  assert.match(source, new RegExp(`/api/projects/${operation}`), `project API exposes ${operation}`);
}
assert.match(header, /LW_PROJECT_REPOSITORY_QUOTA_BYTES/);
assert.match(header, /LW_PROJECT_RECOVERY_HEADROOM_BYTES/);
assert.match(header, /LW_PROJECT_MAX_CHUNK_BYTES/);
assert.match(source, /expectedHead/, 'replace/delete use compare-and-swap expected head');
assert.match(source, /chunkIndex[\s\S]*nextChunkIndex/, 'chunks must arrive in exact order');
assert.match(source, /staging/i);
assert.match(source, /contentHash/);
assert.match(source, /transferHash/, 'serialized transfer bytes have their own verified SHA-256 distinct from the editable project head');
assert.match(header, /currentBlob/, 'head maps editable project content hash to the immutable transfer blob');
assert.match(source, /sha256/i);
assert.match(source, /readback/i, 'commit performs full post-close readback verification');
assert.match(source, /immutable/i, 'commit writes an immutable content-addressed version');
assert.match(source, /head\.tmp[\s\S]*rename/, 'a small head pointer is promoted atomically');
assert.match(source, /knownGood|recovery/i, 'the prior known-good project remains referenced');
assert.match(source, /cleanupAbandonedStaging/, 'boot cleanup abandons staging without touching head');
assert.match(source, /installed configuration is separate|complete editable project/i,
  'the source keeps installed hardware configuration distinct from a complete project');
assert.match(source, /RAW_START[\s\S]*clientContentLength\(\)[\s\S]*LW_PROJECT_HTTP_MAX_BODY_BYTES/,
  'project control/chunk bodies are bounded before allocation');
assert.match(web, /registerLightweaverProjectRepository/);

function promote(state, next, crashAfter) {
  const steps = [
    () => { state.stagedClosed = true; },
    () => { state.hashVerified = true; },
    () => { state.readbackVerified = true; },
    () => { state.versions[next.hash] = next.bytes; },
    () => { state.tempHead = { current: next.hash, knownGood: state.head.current }; },
    () => { state.head = state.tempHead; delete state.tempHead; },
    () => { delete state.staging; },
  ];
  for (let i = 0; i < steps.length; i += 1) {
    steps[i]();
    if (i + 1 === crashAfter) return;
  }
}
for (let cut = 1; cut <= 7; cut += 1) {
  const state = { head: { current: 'v1', knownGood: '' }, versions: { v1: 'old' }, staging: 'new' };
  promote(state, { hash: 'v2', bytes: 'new' }, cut);
  assert.ok(state.head.current === 'v1' || (state.head.current === 'v2' && state.head.knownGood === 'v1'),
    `power cut ${cut} leaves old head or promoted head with recovery`);
  assert.equal(state.versions[state.head.current] !== undefined, true, `head at cut ${cut} resolves`);
}

console.log('windowless project repository tests passed');
