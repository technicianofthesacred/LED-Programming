import assert from 'node:assert/strict';
import {
  ensureCardSectionsForPreview,
  missingCardZoneIds,
  runtimeZoneIds,
  syncRuntimePackageToCard,
  waitForCardZones,
} from '../src/lib/cardSectionSync.js';

const runtimePackage = {
  config: {
    zones: [
      { id: 'outer' },
      { id: 'inner' },
    ],
  },
};

assert.deepEqual(runtimeZoneIds(runtimePackage), ['outer', 'inner']);
assert.deepEqual(
  missingCardZoneIds({ zones: [{ id: 'outer' }] }, ['outer', 'inner', 'inner']),
  ['inner'],
);
assert.deepEqual(missingCardZoneIds(null, ['outer']), []);

let configPushes = 0;
const alreadyReady = await ensureCardSectionsForPreview({
  host: '192.168.4.1',
  requiredZoneIds: ['outer', 'inner'],
  runtimePackage,
  readZones: async () => ({ zones: [{ id: 'outer' }, { id: 'inner' }] }),
  pushConfig: async () => {
    configPushes += 1;
    return { ok: true };
  },
  sleep: async () => {},
});
assert.equal(alreadyReady.synced, false);
assert.equal(configPushes, 0);

const operations = [];
let zoneReads = 0;
const repaired = await ensureCardSectionsForPreview({
  host: '192.168.4.1',
  requiredZoneIds: ['outer', 'inner'],
  runtimePackage,
  readZones: async () => {
    operations.push('zones');
    zoneReads += 1;
    return zoneReads === 1
      ? { zones: [{ id: 'full-piece' }] }
      : { zones: [{ id: 'outer' }, { id: 'inner' }] };
  },
  pushConfig: async (_pkg, options) => {
    operations.push('config');
    assert.equal(options.allowLayoutChange, undefined);
    assert.equal(options.allowProjectChange, undefined);
    return { ok: true };
  },
  sleep: async () => {},
});
assert.equal(repaired.synced, true);
assert.deepEqual(operations, ['zones', 'config', 'zones']);

let unavailableReads = 0;
await assert.rejects(
  waitForCardZones({
    host: '192.168.4.1',
    requiredZoneIds: ['outer', 'inner'],
    attempts: 3,
    intervalMs: 0,
    readZones: async () => {
      unavailableReads += 1;
      return { zones: [{ id: 'full-piece' }] };
    },
    sleep: async () => {},
  }),
  error => error?.reason === 'zones-missing',
);
assert.equal(unavailableReads, 3);

const layoutMismatch = new Error('output layout changed');
layoutMismatch.reason = 'layout-mismatch';
await assert.rejects(
  ensureCardSectionsForPreview({
    host: '192.168.4.1',
    requiredZoneIds: ['outer'],
    runtimePackage,
    readZones: async () => ({ zones: [{ id: 'full-piece' }] }),
    pushConfig: async () => { throw layoutMismatch; },
    sleep: async () => {},
  }),
  error => error === layoutMismatch,
);

const projectMismatch = new Error('wrong project');
projectMismatch.reason = 'project-mismatch';
await assert.rejects(
  syncRuntimePackageToCard({
    host: '192.168.4.1',
    runtimePackage,
    pushConfig: async () => { throw projectMismatch; },
    readZones: async () => ({ zones: [] }),
    sleep: async () => {},
  }),
  error => error === projectMismatch,
);

console.log('card-section-sync tests passed');
