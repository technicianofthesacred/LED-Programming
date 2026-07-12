import assert from 'node:assert/strict';

import {
  migrateProject,
  createDefaultProject,
  migrateStripIdNamespace,
} from '../src/lib/projectModel.js';
import { expandPatchBoard, chainPixelOffsets } from '../src/lib/patchBoard.js';
import { patchBoardToZones } from '../src/lib/cardRuntimeContract.js';
import { deriveSectionTargets } from '../src/lib/sectionLookModel.js';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const makeStrip = (id, count) => ({
  id,
  name: id,
  pixelCount: count,
  pixels: Array.from({ length: count }, (_, i) => ({ x: i, y: 0, index: i })),
});

const stripPatch = (id, stripId, startLed, endLed) => ({
  id,
  name: id,
  groupId: null,
  source: { type: 'strip', stripId, startLed, endLed, autoRange: false },
  output: { mode: 'normal' },
  playback: {},
});

const offPatch = (id, ledCount) => ({
  id,
  name: `Off ${ledCount}`,
  groupId: null,
  source: { type: 'off', ledCount },
  output: { mode: 'off' },
  playback: {},
});

// Matches the sanitizeId used by cardRuntimeContract for zone ids.
const sanitizeId = v => String(v || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

// The OLD (pre-refactor) offset math, inlined verbatim so the parity test can
// compare byte-for-byte against the shipped strips[]-cursor behavior.
function oldPatchBoardToZones(patchBoard, strips = []) {
  const stripPixelOffsets = new Map();
  let cursor = 0;
  for (const strip of strips) {
    stripPixelOffsets.set(strip.id, cursor);
    cursor += strip.pixelCount ?? strip.pixels?.length ?? 0;
  }
  return patchBoard.patches
    .filter(p => p?.source?.type === 'strip' && p.output?.mode !== 'off')
    .map(p => {
      const stripOffset = stripPixelOffsets.get(p.source.stripId) || 0;
      const start = stripOffset + (p.source.startLed || 0);
      const count = (p.source.endLed - p.source.startLed) + 1;
      return { id: sanitizeId(p.id || `zone-${start}`), start, count };
    });
}

function oldSectionTargets(patchBoard, strips = []) {
  const stripPixelOffsets = new Map();
  let cursor = 0;
  for (const strip of strips) {
    stripPixelOffsets.set(strip.id, cursor);
    cursor += strip.pixelCount || strip.pixels?.length || 0;
  }
  const targets = [];
  for (const patch of patchBoard.patches || []) {
    if (patch?.source?.type !== 'strip' || patch.output?.mode === 'off') continue;
    const start = Number(patch.source.startLed);
    const end = Number(patch.source.endLed);
    const pixelCount = Math.abs(Math.trunc(end) - Math.trunc(start)) + 1;
    const offset = stripPixelOffsets.get(patch.source.stripId) || 0;
    const startLed = Number.isFinite(start) ? Math.trunc(start) : 0;
    targets.push({
      id: patch.id,
      start: offset + Math.max(0, startLed),
      end: offset + Math.max(0, startLed) + Math.max(0, pixelCount - 1),
      pixelCount,
    });
  }
  return targets;
}

const addressMap = zones =>
  new Map(zones.map(z => {
    const start = z.ranges ? z.ranges[0].start : z.start;
    const count = z.ranges ? z.ranges[0].count : z.count;
    return [z.id, { start, count }];
  }));

const targetAddressMap = targets =>
  new Map(targets
    .filter(t => t.kind !== 'all')
    .map(t => [t.id, { start: t.start, end: t.end, pixelCount: t.pixelCount }]));

const chainOrder = project => project.layout.patchBoard.chains[0].rowIds;

// ─────────────────────────────────────────────────────────────────────────
// 1. A v3 project whose chain order diverges from strips[] order is realigned.
//    Off rows preserved, split segments intact.
// ─────────────────────────────────────────────────────────────────────────

const divergentV3 = () => ({
  version: 3,
  id: 'lwproj-divergent',
  name: 'Divergent',
  layout: {
    strips: [makeStrip('A', 3), makeStrip('B', 2), makeStrip('C', 4)],
    patchBoard: {
      physicalLocked: false,
      groups: [],
      chains: [{
        id: 'main',
        name: 'Main physical strip',
        // Divergent from strips[] order [A, B, C]; A is split; an off row sits
        // in the middle.
        rowIds: ['patch-C', 'off-1', 'patch-B', 'patch-A-1-2', 'patch-A-0-0'],
      }],
      patches: [
        stripPatch('patch-A-0-0', 'A', 0, 0),
        stripPatch('patch-A-1-2', 'A', 1, 2),
        stripPatch('patch-B', 'B', 0, 1),
        stripPatch('patch-C', 'C', 0, 3),
        offPatch('off-1', 3),
      ],
    },
  },
});

{
  const migrated = migrateProject(divergentV3());
  // Strips A/B/C are re-homed onto the strip-<n> namespace (A→strip-1, …), so
  // patch ids follow. Chain now follows strips[] order (strip-1's segments
  // ascending), off row pinned to its slot (index 1).
  assert.deepEqual(chainOrder(migrated), [
    'patch-strip-1-0-0', 'off-1', 'patch-strip-1-1-2', 'patch-strip-2', 'patch-strip-3',
  ]);
  assert.deepEqual(migrated.layout.strips.map(s => s.id), ['strip-1', 'strip-2', 'strip-3']);

  // Off row still present exactly once; both split segments retained.
  const rows = chainOrder(migrated);
  assert.equal(rows.filter(id => id === 'off-1').length, 1);
  assert.ok(rows.includes('patch-strip-1-0-0') && rows.includes('patch-strip-1-1-2'));
}

// ─────────────────────────────────────────────────────────────────────────
// 2. The default project passes through unchanged.
// ─────────────────────────────────────────────────────────────────────────

{
  const def = createDefaultProject();
  const before = def.layout.patchBoard.chains[0].rowIds.slice();
  const migrated = migrateProject(createDefaultProject());
  assert.deepEqual(migrated.layout.patchBoard.chains[0].rowIds, before);
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Parity: OLD math on the pre-migration board == NEW math on the
//    post-migration board (byte-identical LED addressing for normal installs,
//    i.e. no off blocks shifting a strip's address).
// ─────────────────────────────────────────────────────────────────────────

const divergentNoOffV3 = () => ({
  version: 3,
  id: 'lwproj-divergent-nooff',
  name: 'Divergent no off',
  layout: {
    strips: [makeStrip('A', 3), makeStrip('B', 2), makeStrip('C', 4)],
    patchBoard: {
      physicalLocked: false,
      groups: [],
      chains: [{
        id: 'main',
        name: 'Main physical strip',
        rowIds: ['patch-C', 'patch-B', 'patch-A-1-2', 'patch-A-0-0'],
      }],
      patches: [
        stripPatch('patch-A-0-0', 'A', 0, 0),
        stripPatch('patch-A-1-2', 'A', 1, 2),
        stripPatch('patch-B', 'B', 0, 1),
        stripPatch('patch-C', 'C', 0, 3),
      ],
    },
  },
});

{
  const pre = divergentNoOffV3();
  const preBoard = pre.layout.patchBoard;
  const preStrips = pre.layout.strips;

  // NEW math runs on the migrated (post) board — whose strip + patch ids have
  // been re-homed onto the strip-<n> namespace. The id remap is pure renaming,
  // so LED addresses are unchanged; we compare the ordered address sequence
  // (start/count) rather than by id.
  const migrated = migrateProject(divergentNoOffV3());
  const postBoard = migrated.layout.patchBoard;
  const postStrips = migrated.layout.strips;

  const addrSeq = zones => zones.map(z => ({
    start: z.ranges ? z.ranges[0].start : z.start,
    count: z.ranges ? z.ranges[0].count : z.count,
  }));
  const targetSeq = targets => targets
    .filter(t => t.kind !== 'all')
    .map(t => ({ start: t.start, end: t.end, pixelCount: t.pixelCount }));

  // patchBoardToZones parity (address sequence, ids ignored).
  assert.deepEqual(
    addrSeq(patchBoardToZones(postBoard, postStrips)),
    addrSeq(oldPatchBoardToZones(preBoard, preStrips)),
    'patchBoardToZones address parity',
  );

  // deriveSectionTargets parity (address sequence, ids ignored).
  assert.deepEqual(
    targetSeq(deriveSectionTargets({ strips: postStrips, patchBoard: postBoard })),
    targetSeq(oldSectionTargets(preBoard, preStrips)),
    'deriveSectionTargets address parity',
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 4. New chain-order addressing agrees with expandPatchBoard (the runtime frame
//    addressing) even when off blocks reserve addresses — the correcting
//    behavior the OLD strip-cursor math did not have.
// ─────────────────────────────────────────────────────────────────────────

{
  const migrated = migrateProject(divergentV3());
  const board = migrated.layout.patchBoard;
  const strips = migrated.layout.strips;
  const expanded = expandPatchBoard(board, strips);
  const offsets = chainPixelOffsets(board, strips);

  // Every patch (strip AND off) lands at the same start index the runtime frame
  // assigns it — proving zone addressing now tracks off-block reservations.
  for (const row of expanded.rows) {
    assert.equal(
      offsets.get(row.patchId),
      row.startIndex,
      `chain offset for ${row.patchId} matches expandPatchBoard start index`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Strip id namespace migration: a legacy project whose strips reuse their
//    source layer/path ids is re-homed onto strip-<n>, and every reference
//    (patch ids, source.stripId, chain rowIds, strip-group members, hidden
//    keys) is rewritten atomically. editCounts stays with the layer.
// ─────────────────────────────────────────────────────────────────────────

const legacyNamespaceV3 = () => ({
  version: 3,
  id: 'lwproj-legacy-ns',
  name: 'Legacy namespace',
  layout: {
    // Whole-layer strip 'ring' (split), sub-path strip 'ring-a', freehand 'drawn-9'.
    strips: [makeStrip('ring', 10), makeStrip('ring-a', 5), makeStrip('drawn-9', 3)],
    editCounts: { ring: 20 },              // keyed by the layer — must be left alone
    hidden: { ring: true, 'drawn-9': true },
    layerGroups: [{
      groupId: 'grp-1',
      type: 'strip',
      name: 'Group',
      members: [
        { type: 'strip', stripId: 'ring', pathId: 'ring', layerId: 'ring' },
        { type: 'strip', stripId: 'ring-a', pathId: 'ring-a', layerId: 'ring-a' },
        { pathId: 'other-path', layerId: 'other-layer', pathData: 'M0 0' }, // path member: no stripId
      ],
    }],
    patchBoard: {
      physicalLocked: false,
      groups: [],
      chains: [{
        id: 'main',
        name: 'Main physical strip',
        rowIds: ['patch-ring-0-4', 'patch-ring-5-9', 'patch-ring-a', 'patch-drawn-9'],
      }],
      patches: [
        stripPatch('patch-ring-0-4', 'ring', 0, 4),
        stripPatch('patch-ring-5-9', 'ring', 5, 9),
        stripPatch('patch-ring-a', 'ring-a', 0, 4),
        stripPatch('patch-drawn-9', 'drawn-9', 0, 2),
      ],
    },
  },
});

{
  const migrated = migrateProject(legacyNamespaceV3());
  const { strips, patchBoard, editCounts, hidden, layerGroups } = migrated.layout;

  // Strip ids re-homed; old ids recovered as sourceLayerId.
  assert.deepEqual(strips.map(s => s.id), ['strip-1', 'strip-2', 'strip-3']);
  assert.equal(strips[0].sourceLayerId, 'ring');
  assert.equal(strips[1].sourceLayerId, 'ring-a');
  assert.equal(strips[2].sourceLayerId, 'drawn-9');

  // Patch ids + source.stripId rewritten; split suffix preserved.
  const patchIds = patchBoard.patches.map(p => p.id).sort();
  assert.deepEqual(patchIds, [
    'patch-strip-1-0-4', 'patch-strip-1-5-9', 'patch-strip-2', 'patch-strip-3',
  ].sort());
  const stripSources = patchBoard.patches
    .filter(p => p.source?.type === 'strip')
    .map(p => p.source.stripId);
  assert.ok(stripSources.every(id => /^strip-\d+$/.test(id)));

  // Chain rowIds point at the new patch ids (order preserved; already strip order).
  assert.deepEqual(patchBoard.chains[0].rowIds, [
    'patch-strip-1-0-4', 'patch-strip-1-5-9', 'patch-strip-2', 'patch-strip-3',
  ]);

  // Strip-group members: stripId remapped; path member (no stripId) untouched.
  const members = layerGroups[0].members;
  assert.equal(members[0].stripId, 'strip-1');
  assert.equal(members[1].stripId, 'strip-2');
  assert.equal(members[2].stripId, undefined);
  assert.equal(members[2].pathId, 'other-path');

  // editCounts stays with the layer key; hidden flag copied onto the new strip
  // keys while the old (layer-shared) keys are kept.
  assert.deepEqual(editCounts, { ring: 20 });
  assert.equal(hidden['strip-1'], true);   // ring's hidden flag now reaches the strip
  assert.equal(hidden.ring, true);          // and still reaches the layer
  assert.equal(hidden['strip-3'], true);   // freehand strip's flag moved across
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Loading a legacy project then exporting zones yields identical LED
//    addresses to the pre-remap export (the id remap is pure renaming).
// ─────────────────────────────────────────────────────────────────────────

{
  const pre = legacyNamespaceV3();
  const oldAddrs = oldPatchBoardToZones(pre.layout.patchBoard, pre.layout.strips)
    .map(z => ({ start: z.start, count: z.count }));

  const migrated = migrateProject(legacyNamespaceV3());
  const newAddrs = patchBoardToZones(migrated.layout.patchBoard, migrated.layout.strips)
    .map(z => ({ start: z.ranges[0].start, count: z.ranges[0].count }));

  assert.deepEqual(newAddrs, oldAddrs, 'legacy export addresses survive the id remap');
}

// ─────────────────────────────────────────────────────────────────────────
// 7. Migration is idempotent: re-running it changes nothing.
// ─────────────────────────────────────────────────────────────────────────

{
  const once = migrateProject(legacyNamespaceV3());
  const twice = migrateProject(once);
  assert.deepEqual(twice.layout.strips.map(s => s.id), once.layout.strips.map(s => s.id));
  assert.deepEqual(chainOrder(twice), chainOrder(once));
  assert.deepEqual(
    twice.layout.patchBoard.patches.map(p => p.id).sort(),
    once.layout.patchBoard.patches.map(p => p.id).sort(),
  );

  // Direct idempotency on the primitive: a project already on the namespace is
  // untouched (empty old→new map, no mutation).
  const already = migrateProject(legacyNamespaceV3());
  const before = JSON.stringify(already.layout.strips.map(s => s.id));
  migrateStripIdNamespace(already);
  assert.equal(JSON.stringify(already.layout.strips.map(s => s.id)), before);
}

console.log('layout-migration.mjs: all assertions passed');
