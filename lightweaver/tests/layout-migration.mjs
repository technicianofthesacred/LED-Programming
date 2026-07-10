import assert from 'node:assert/strict';

import { migrateProject, createDefaultProject } from '../src/lib/projectModel.js';
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
  // Chain now follows strips[] order (A's segments ascending), off row pinned
  // to its slot (index 1).
  assert.deepEqual(chainOrder(migrated), [
    'patch-A-0-0', 'off-1', 'patch-A-1-2', 'patch-B', 'patch-C',
  ]);

  // Off row still present exactly once; both split segments retained.
  const rows = chainOrder(migrated);
  assert.equal(rows.filter(id => id === 'off-1').length, 1);
  assert.ok(rows.includes('patch-A-0-0') && rows.includes('patch-A-1-2'));
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
  const strips = pre.layout.strips;

  // NEW math runs on the migrated (post) board.
  const migrated = migrateProject(divergentNoOffV3());
  const postBoard = migrated.layout.patchBoard;

  // patchBoardToZones parity.
  const oldZones = addressMap(oldPatchBoardToZones(preBoard, strips));
  const newZones = addressMap(patchBoardToZones(postBoard, strips));
  assert.equal(newZones.size, oldZones.size);
  for (const [id, addr] of oldZones) {
    assert.deepEqual(newZones.get(id), addr, `patchBoardToZones parity for ${id}`);
  }

  // deriveSectionTargets parity.
  const oldTargets = targetAddressMap(oldSectionTargets(preBoard, strips));
  const newTargets = targetAddressMap(deriveSectionTargets({ strips, patchBoard: postBoard }));
  assert.equal(newTargets.size, oldTargets.size);
  for (const [id, addr] of oldTargets) {
    assert.deepEqual(newTargets.get(id), addr, `deriveSectionTargets parity for ${id}`);
  }
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

console.log('layout-migration.mjs: all assertions passed');
