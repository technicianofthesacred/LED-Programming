import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportProjectToFile,
  importProjectFromPickedFile,
  unwrapProjectFileDocument,
} from './projectTransfer.js';
import { createDefaultProject } from './projectModel.js';
import { createProjectEnvelope } from './projectRepository.js';

function sampleProject() {
  return { ...createDefaultProject(), id: 'transfer-test-project', name: 'Ocean Glow' };
}

// A fake for the Phase 2 file mechanics: parses nothing, hands `data`
// straight to the callback exactly as importProjectFromFile does after
// FileReader + JSON.parse.
function fakeReadProjectFile(data) {
  return async (file, replaceProject) => replaceProject(structuredClone(data));
}

// ── unwrapProjectFileDocument ──────────────────────────────────────────────

test('a bare project document passes through untouched', () => {
  const project = sampleProject();
  assert.equal(unwrapProjectFileDocument(project), project);
});

test('a repository envelope is detected and unwrapped to its project', () => {
  const project = sampleProject();
  const envelope = createProjectEnvelope(project);
  const unwrapped = unwrapProjectFileDocument(envelope);
  assert.equal(unwrapped, envelope.project);
  assert.equal(unwrapped.id, project.id);
});

test('a minimal { envelopeVersion, project } shape unwraps without full envelope metadata', () => {
  const project = sampleProject();
  const unwrapped = unwrapProjectFileDocument({ envelopeVersion: 1, project });
  assert.equal(unwrapped, project);
});

test('documents that merely mention project or envelopeVersion do not unwrap', () => {
  const withProjectString = { envelopeVersion: 1, project: 'not-a-document' };
  assert.equal(unwrapProjectFileDocument(withProjectString), withProjectString);
  const noVersion = { project: sampleProject() };
  assert.equal(unwrapProjectFileDocument(noVersion), noVersion);
  const array = [sampleProject()];
  assert.equal(unwrapProjectFileDocument(array), array);
  assert.equal(unwrapProjectFileDocument(null), null);
  assert.equal(unwrapProjectFileDocument('text'), 'text');
});

// ── exportProjectToFile ────────────────────────────────────────────────────

test('export downloads the raw serialized project under the canonical name and marks file persistence', async () => {
  const project = sampleProject();
  const downloads = [];
  const persisted = [];
  const ok = await exportProjectToFile({
    serializeProject: () => project,
    projectName: "Ocean Glow's Piece",
    markPersisted: destination => persisted.push(destination),
    download: async (filename, payload) => { downloads.push({ filename, payload }); return true; },
  });
  assert.equal(ok, true);
  assert.deepEqual(downloads, [{ filename: 'ocean-glows-piece.lw.json', payload: project }]);
  assert.deepEqual(persisted, ['file']);
});

test('a failed or dismissed download marks nothing persisted', async () => {
  const persisted = [];
  const ok = await exportProjectToFile({
    serializeProject: sampleProject,
    projectName: 'Ocean Glow',
    markPersisted: destination => persisted.push(destination),
    download: async () => false,
  });
  assert.equal(ok, false);
  assert.deepEqual(persisted, []);
});

test('a caller-supplied payload builder replaces the default serialization but not the naming', async () => {
  const downloads = [];
  const serialized = [];
  await exportProjectToFile({
    serializeProject: () => { serialized.push(true); return sampleProject(); },
    projectName: 'Ocean Glow',
    buildPayload: () => ({ custom: true }),
    download: async (filename, payload) => { downloads.push({ filename, payload }); return true; },
  });
  assert.deepEqual(downloads, [{ filename: 'ocean-glow.lw.json', payload: { custom: true } }]);
  assert.deepEqual(serialized, [], 'buildPayload owns the payload; serializeProject is not consulted');
});

// ── importProjectFromPickedFile ────────────────────────────────────────────

function cleanupSpies(calls) {
  return {
    clearBrowserAssociation: () => calls.push('clearBrowserAssociation'),
    detachCloudProject: () => calls.push('detachCloudProject'),
    clearSaveBlock: () => calls.push('clearSaveBlock'),
  };
}

test('a committed import runs the full cleanup in order: browser, cloud, save block', async () => {
  const calls = [];
  const result = await importProjectFromPickedFile({}, {
    replaceProject: async () => { calls.push('replaceProject'); return { ok: true }; },
    ...cleanupSpies(calls),
    readProjectFile: fakeReadProjectFile(sampleProject()),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['replaceProject', 'clearBrowserAssociation', 'detachCloudProject', 'clearSaveBlock']);
});

test('replaceProject receives the bare project when the file holds an envelope', async () => {
  const project = sampleProject();
  const received = [];
  await importProjectFromPickedFile({}, {
    replaceProject: async data => { received.push(data); return { ok: true }; },
    readProjectFile: fakeReadProjectFile(createProjectEnvelope(project)),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].id, project.id);
  assert.equal(received[0].envelopeVersion, undefined, 'the envelope metadata must not reach replaceProject');
});

test('replaceProject receives a bare project file as-is', async () => {
  const project = sampleProject();
  const received = [];
  await importProjectFromPickedFile({}, {
    replaceProject: async data => { received.push(data); return { ok: true }; },
    readProjectFile: fakeReadProjectFile(project),
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].id, project.id);
});

test('a declined or invalid replacement runs no cleanup at all', async () => {
  const calls = [];
  const result = await importProjectFromPickedFile({}, {
    replaceProject: async () => ({ ok: false, reason: 'invalid' }),
    ...cleanupSpies(calls),
    readProjectFile: fakeReadProjectFile(sampleProject()),
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid' });
  assert.deepEqual(calls, []);
});

test('a throwing replaceProject rejects and runs no cleanup', async () => {
  const calls = [];
  await assert.rejects(() => importProjectFromPickedFile({}, {
    replaceProject: async () => { throw new Error('replacement failed'); },
    ...cleanupSpies(calls),
    readProjectFile: fakeReadProjectFile(sampleProject()),
  }), /replacement failed/);
  assert.deepEqual(calls, []);
});

test('missing cleanup handles are tolerated (provider-less harness renders)', async () => {
  const result = await importProjectFromPickedFile({}, {
    replaceProject: async () => ({ ok: true }),
    readProjectFile: fakeReadProjectFile(sampleProject()),
  });
  assert.equal(result.ok, true);
});
