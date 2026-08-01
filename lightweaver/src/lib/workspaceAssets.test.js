import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOM_PATTERNS_KEY,
  CUSTOM_PATTERN_REVISIONS_KEY,
  saveCustomPattern,
  updateCustomPattern,
} from './customPatterns.js';
import { createPatternLabRecipe } from './patternLabRecipe.js';
import {
  PATTERN_LAB_DRAFTS_BACKUP_KEY,
  PATTERN_LAB_DRAFTS_KEY,
  savePatternLabDraft,
} from './patternLabStorage.js';
import {
  WORKSPACE_ASSETS_POINTER_KEY,
  WORKSPACE_ASSETS_EVENT,
  WORKSPACE_ASSETS_VERSION,
  readWorkspaceAssets,
  writeWorkspaceAssets,
} from './workspaceAssets.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  const writes = [];
  return {
    data,
    writes,
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem(key, value) {
      writes.push(key);
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function completeSnapshot() {
  const current = {
    id: 'custom-clouds',
    name: 'Clouds',
    code: 'return hsv(time, 1, 1);',
    custom: true,
  };
  const prior = { ...current, code: 'return hsv(time, .5, 1);' };
  return {
    version: WORKSPACE_ASSETS_VERSION,
    customPatterns: [current],
    customPatternRevisions: { 'custom-clouds': [prior] },
    patternLabDrafts: [createPatternLabRecipe({ id: 'draft-clouds', name: 'Cloud study' })],
  };
}

test('round-trips complete custom pattern, revision, and Pattern Lab state', () => {
  const storage = memoryStorage();
  const snapshot = completeSnapshot();

  const written = writeWorkspaceAssets(snapshot, storage, { dispatch: false });

  assert.deepEqual(written, snapshot);
  assert.deepEqual(readWorkspaceAssets(storage), snapshot);
  assert.ok(storage.getItem(CUSTOM_PATTERNS_KEY));
  assert.ok(storage.getItem(CUSTOM_PATTERN_REVISIONS_KEY));
  assert.ok(storage.getItem(PATTERN_LAB_DRAFTS_KEY));
  assert.equal(storage.getItem(PATTERN_LAB_DRAFTS_BACKUP_KEY), storage.getItem(PATTERN_LAB_DRAFTS_KEY));
});

test('reads the committed workspace snapshot before best-effort legacy mirrors', () => {
  const storage = memoryStorage();
  const snapshot = completeSnapshot();
  writeWorkspaceAssets(snapshot, storage, { dispatch: false });

  storage.setItem(CUSTOM_PATTERNS_KEY, JSON.stringify([{ id: 'hybrid', name: 'Hybrid', code: '' }]));
  storage.setItem(CUSTOM_PATTERN_REVISIONS_KEY, JSON.stringify({}));
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, JSON.stringify({ version: 2, drafts: [] }));

  assert.deepEqual(readWorkspaceAssets(storage), snapshot);
});

test('reads valid legacy mirrors when no committed snapshot pointer exists', () => {
  const snapshot = completeSnapshot();
  const storage = memoryStorage({
    [CUSTOM_PATTERNS_KEY]: JSON.stringify(snapshot.customPatterns),
    [CUSTOM_PATTERN_REVISIONS_KEY]: JSON.stringify(snapshot.customPatternRevisions),
    [PATTERN_LAB_DRAFTS_KEY]: JSON.stringify({ version: 2, drafts: snapshot.patternLabDrafts }),
    [PATTERN_LAB_DRAFTS_BACKUP_KEY]: JSON.stringify({ version: 2, drafts: snapshot.patternLabDrafts }),
  });

  assert.deepEqual(readWorkspaceAssets(storage), snapshot);
});

test('validates every collection before making the first local write', () => {
  const storage = memoryStorage({ untouched: 'yes' });
  const invalid = completeSnapshot();
  invalid.customPatternRevisions['custom-clouds'] = [{ ...invalid.customPatterns[0], id: '' }];

  assert.throws(() => writeWorkspaceAssets(invalid, storage), /custom pattern revision/i);
  assert.deepEqual(storage.writes, []);
  assert.equal(storage.getItem('untouched'), 'yes');
});

test('rejects an invalid Pattern Lab draft before changing custom patterns', () => {
  const storage = memoryStorage({
    [CUSTOM_PATTERNS_KEY]: JSON.stringify([{ id: 'original', name: 'Original', code: '', custom: true }]),
  });
  const before = storage.getItem(CUSTOM_PATTERNS_KEY);
  const invalid = completeSnapshot();
  invalid.patternLabDrafts = [{ version: 99, id: 'future' }];

  assert.throws(() => writeWorkspaceAssets(invalid, storage), /unsupported pattern lab recipe version/i);
  assert.equal(storage.getItem(CUSTOM_PATTERNS_KEY), before);
  assert.deepEqual(storage.writes, []);
});

test('rejects lossy custom pattern values and unsupported stored draft envelopes', () => {
  const storage = memoryStorage();
  const unsafe = completeSnapshot();
  unsafe.customPatterns[0].extension = Number.NaN;
  assert.throws(() => writeWorkspaceAssets(unsafe, storage), /json-safe/i);
  assert.deepEqual(storage.writes, []);

  storage.setItem(PATTERN_LAB_DRAFTS_KEY, JSON.stringify({ version: 99, drafts: [] }));
  storage.writes.length = 0;
  assert.throws(() => readWorkspaceAssets(storage), /unsupported pattern lab draft version/i);
  assert.deepEqual(storage.writes, []);
});

test('persistent write failure cannot expose a hybrid workspace state', () => {
  const original = completeSnapshot();
  original.customPatterns[0].name = 'Original';
  const storage = memoryStorage();
  writeWorkspaceAssets(original, storage, { dispatch: false });
  const originalPointer = storage.getItem(WORKSPACE_ASSETS_POINTER_KEY);
  let writes = 0;
  const failingStorage = {
    getItem: storage.getItem,
    removeItem() { throw new DOMException('persistent quota', 'QuotaExceededError'); },
    setItem(key, value) {
      writes += 1;
      if (writes >= 2) throw new DOMException('persistent quota', 'QuotaExceededError');
      storage.data.set(key, String(value));
    },
  };
  const replacement = completeSnapshot();
  replacement.customPatterns[0].name = 'Replacement';

  assert.throws(() => writeWorkspaceAssets(replacement, failingStorage), /persistent quota/i);
  assert.equal(storage.getItem(WORKSPACE_ASSETS_POINTER_KEY), originalPointer);
  assert.deepEqual(readWorkspaceAssets(storage), original);
});

test('legacy mirror failures after the pointer switch do not invalidate the committed snapshot', () => {
  const original = completeSnapshot();
  original.customPatterns[0].name = 'Original';
  const storage = memoryStorage();
  writeWorkspaceAssets(original, storage, { dispatch: false });
  let writes = 0;
  const legacyFailingStorage = {
    getItem: storage.getItem,
    removeItem() { throw new DOMException('persistent quota', 'QuotaExceededError'); },
    setItem(key, value) {
      writes += 1;
      if (writes >= 3) throw new DOMException('persistent quota', 'QuotaExceededError');
      storage.data.set(key, String(value));
    },
  };
  const replacement = completeSnapshot();
  replacement.customPatterns[0].name = 'Replacement';

  assert.deepEqual(
    writeWorkspaceAssets(replacement, legacyFailingStorage, { dispatch: false }),
    replacement,
  );
  assert.deepEqual(readWorkspaceAssets(legacyFailingStorage), replacement);
  assert.equal(JSON.parse(storage.getItem(CUSTOM_PATTERNS_KEY))[0].name, 'Original');
});

test('custom-pattern and Pattern Lab mutations each dispatch one workspace change event', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  const events = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dispatchEvent: event => events.push(event.type) },
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class CustomEvent { constructor(type) { this.type = type; } },
  });

  try {
    const storage = memoryStorage();
    saveCustomPattern({ id: 'custom-one', name: 'One', code: '' }, { storage });
    assert.equal(events.filter(type => type === WORKSPACE_ASSETS_EVENT).length, 1);

    events.length = 0;
    updateCustomPattern('custom-one', { name: 'One revised' }, { storage });
    assert.equal(events.filter(type => type === WORKSPACE_ASSETS_EVENT).length, 1);

    events.length = 0;
    savePatternLabDraft(createPatternLabRecipe({ id: 'draft-one' }), { storage });
    assert.deepEqual(events, [WORKSPACE_ASSETS_EVENT]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
    else delete globalThis.CustomEvent;
  }
});

test('a failing legacy custom-pattern listener cannot suppress the workspace event', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalCustomEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
  const events = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dispatchEvent(event) {
        if (event.type === 'lw:custom-updated') throw new Error('legacy listener failed');
        events.push(event.type);
      },
    },
  });
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    value: class CustomEvent { constructor(type) { this.type = type; } },
  });

  try {
    saveCustomPattern({ id: 'custom-safe-event', name: 'Safe event', code: '' }, {
      storage: memoryStorage(),
    });
    assert.deepEqual(events, [WORKSPACE_ASSETS_EVENT]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
    if (originalCustomEvent) Object.defineProperty(globalThis, 'CustomEvent', originalCustomEvent);
    else delete globalThis.CustomEvent;
  }
});
