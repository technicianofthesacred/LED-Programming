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
assert.deepEqual(missingCardZoneIds(null, ['outer']), ['outer']);

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
    // Preview auto-sync must never force a wiring/project change past the guard.
    assert.ok(!options.allowLayoutChange);
    assert.ok(!options.allowProjectChange);
    return { ok: true };
  },
  sleep: async () => {},
});
assert.equal(repaired.synced, true);
assert.deepEqual(operations, ['zones', 'config', 'zones']);
assert.deepEqual(repaired.zones.zones.map(zone => zone.id), ['outer', 'inner']);

let releaseConcurrentConfig;
const concurrentConfigGate = new Promise(resolve => { releaseConcurrentConfig = resolve; });
let concurrentConfigPushes = 0;
let concurrentReady = false;
const concurrentOptions = {
  host: '192.168.4.1',
  runtimePackage,
  readZones: async () => concurrentReady
    ? { zones: [{ id: 'outer' }, { id: 'inner' }] }
    : { zones: [{ id: 'full-piece' }] },
  pushConfig: async () => {
    concurrentConfigPushes += 1;
    await concurrentConfigGate;
    concurrentReady = true;
    return { ok: true };
  },
  sleep: async () => {},
};
const concurrentOuter = ensureCardSectionsForPreview({
  ...concurrentOptions,
  requiredZoneIds: ['outer'],
});
await new Promise(resolve => setTimeout(resolve, 0));
const concurrentInner = ensureCardSectionsForPreview({
  ...concurrentOptions,
  requiredZoneIds: ['inner'],
});
await new Promise(resolve => setTimeout(resolve, 0));
releaseConcurrentConfig();
await Promise.all([concurrentOuter, concurrentInner]);
assert.equal(concurrentConfigPushes, 1);

let releaseProjectConfigs;
const projectConfigGate = new Promise(resolve => { releaseProjectConfigs = resolve; });
const pushedProjects = [];
const projectPackage = projectId => ({
  config: {
    piece: { id: projectId },
    led: { outputs: [{ id: 'out1', pin: 16, pixels: 44 }] },
    zones: [{ id: 'outer', ranges: [{ start: 0, count: 44 }] }],
  },
});
const projectOptions = runtimePackageForProject => ensureCardSectionsForPreview({
  host: '192.168.4.1',
  requiredZoneIds: ['outer'],
  runtimePackage: runtimePackageForProject,
  readZones: async () => ({ zones: [{ id: 'full-piece' }] }),
  pushConfig: async pkg => {
    pushedProjects.push(pkg.config.piece.id);
    await projectConfigGate;
    return { ok: true };
  },
  sleep: async () => {},
});
const projectA = projectOptions(projectPackage('project-a'));
const projectB = projectOptions(projectPackage('project-b'));
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(pushedProjects.sort(), ['project-a', 'project-b']);
releaseProjectConfigs();
await Promise.allSettled([projectA, projectB]);

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

let rebootWindowReads = 0;
await assert.rejects(
  waitForCardZones({
    host: '192.168.4.1',
    requiredZoneIds: ['outer'],
    intervalMs: 0,
    readZones: async () => {
      rebootWindowReads += 1;
      throw new Error('card rebooting');
    },
    sleep: async () => {},
  }),
  error => error?.reason === 'zones-missing',
);
assert.equal(rebootWindowReads, 20);

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
