import { PALETTE_DEFAULT } from '../data.js';
import {
  DEFAULT_AUTO_LANES,
  DEFAULT_CLIPS,
  DEFAULT_CUES,
  DEFAULT_TRANSITIONS,
} from '../state/ProjectDefaults.js';
import { normalizeMotionSmoothing } from './motionSmoothing.js';
import {
  DEFAULT_WLED_PHYSICAL_CONTROLS,
  normalizeWledPhysicalControls,
} from './wledControlContract.js';
import {
  DEFAULT_STANDALONE_CONTROLS,
  DEFAULT_STANDALONE_LED,
  DEFAULT_STANDALONE_RUNTIME_MODE,
  DEFAULT_STANDALONE_OUTPUTS,
  STANDALONE_RUNTIME_MODES,
} from './standaloneController.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';
import { normalizeSavedLooks } from './sectionLookModel.js';
import {
  createDefaultPatchBoard,
  DEFAULT_DATA_WIRE_COUNT,
  migrateChainToStripOrder,
  normalizePatchBoard,
} from './patchBoard.js';
import { createDefaultCircleLayout, isDefaultCircleLayout } from './defaultCircleLayout.js';
import { makeDefaultWiring, migrateWiring } from './wiringModel.js';
import { isClosedPathData } from './pathClosure.js';
import {
  deriveLegacyPatternCycleIds,
  isDefaultPatternCycle,
  isImplicitDefaultPatternPlaylist,
  normalizeCardPlaylist,
} from './cardPlaylist.js';

export const PROJECT_VERSION = 3;

export function createProjectId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `lwproj-${Date.now().toString(36)}-${random}`;
}

function normalizeProjectId(value, fallback = createProjectId()) {
  const clean = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

export const DEFAULT_SYM_SETTINGS = {
  enabled: false,
  type: 'none',
  count: 8,
  slices: 6,
  phase: 0,
  twist: 0,
  seam: 0.1,
  center: { x: 0.5, y: 0.5 },
  guide: {
    mode: 'fold',
    axis: { x1: 0.5, y1: 0.08, x2: 0.5, y2: 0.92 },
  },
};

export function defaultStandaloneController(overrides = {}) {
  const runtimeMode = STANDALONE_RUNTIME_MODES.includes(overrides.runtimeMode)
    ? overrides.runtimeMode
    : DEFAULT_STANDALONE_RUNTIME_MODE;
  const defaultLook = normalizeCardVisualLook(overrides.defaultLook);
  const looks = normalizeSavedLooks(overrides.looks || []);
  const controls = {
    ...DEFAULT_STANDALONE_CONTROLS,
    ...(overrides.controls || {}),
    encoder: {
      ...DEFAULT_STANDALONE_CONTROLS.encoder,
      ...(overrides.controls?.encoder || {}),
    },
  };
  const rawCycleIds = Array.isArray(overrides.controls?.encoder?.patternCycleIds)
    ? overrides.controls.encoder.patternCycleIds
    : [];
  const hasConfiguredCycle = rawCycleIds.length > 0 && !isDefaultPatternCycle(rawCycleIds);
  const rawPlaylist = isImplicitDefaultPatternPlaylist(overrides.playlist) ? [] : overrides.playlist;
  const playlist = normalizeCardPlaylist(rawPlaylist, {
    savedLooks: looks,
    fallbackPatternIds: hasConfiguredCycle
      ? [defaultLook.patternId, ...rawCycleIds]
      : [],
    allowEmpty: true,
  });
  return {
    runtimeMode,
    outputs: overrides.outputs || DEFAULT_STANDALONE_OUTPUTS,
    controls: {
      ...controls,
      encoder: {
        ...controls.encoder,
        patternCycleIds: deriveLegacyPatternCycleIds(playlist),
      },
    },
    led: {
      ...DEFAULT_STANDALONE_LED,
      ...(overrides.led || {}),
    },
    defaultLook,
    activeLookId: String(overrides.activeLookId || ''),
    looks,
    playlist,
  };
}

export function createDefaultProject() {
  const defaultStrips = createDefaultCircleLayout();
  return {
    version: PROJECT_VERSION,
    id: createProjectId(),
    name: 'Untitled Project',
    layout: {
      strips: defaultStrips,
      starterPending: true,
      viewBox: '0 0 640 400',
      svgText: null,
      hidden: {},
      layers: [],
      density: 60,
      pxPerMm: 3.7795,
      editCounts: {},
      layerGroups: [],
      layerOrder: [],
      patchBoard: createDefaultPatchBoard(defaultStrips),
      wiring: makeDefaultWiring(defaultStrips),
    },
    pattern: {
      activePatternId: 'aurora',
      palette: PALETTE_DEFAULT,
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
      gammaEnabled: false,
      gammaValue: 2.2,
      patternParams: {},
      bpm: 120,
      symSettings: DEFAULT_SYM_SETTINGS,
      motionSmoothing: 'soft',
    },
    show: {
      clips: DEFAULT_CLIPS,
      transitions: DEFAULT_TRANSITIONS,
      cues: DEFAULT_CUES,
      autoLanes: DEFAULT_AUTO_LANES,
      duration: 600,
    },
    live: {
      quantize: 'free',
      recording: false,
    },
    devices: {
      wledIp: '',
      segmentMap: {},
      physicalControls: DEFAULT_WLED_PHYSICAL_CONTROLS,
      controllerProfiles: [],
      activeControllerId: '',
      standaloneController: defaultStandaloneController(),
    },
  };
}

// Move legacy strips onto their own `strip-<n>` id namespace. Historically a
// strip reused its source layer/path id as its own id, forcing every consumer to
// guess whether an id meant a layer or a strip. This rewrites strip ids and every
// reference to them (patch ids, patch `source.stripId`, chain `rowIds`, strip
// group members, and the strip-keyed `hidden` flags) atomically from a single
// old→new map, recording the old id as `sourceLayerId` so callers can recover the
// artwork a strip came from.
//
// Runs BEFORE the chain alignment below so the chain migration sees final ids.
export function migrateStripIdNamespace(project) {
  const layout = project?.layout;
  if (!layout || !Array.isArray(layout.strips) || !layout.strips.length) return project;
  layout.strips = layout.strips.map(strip => ({
    ...strip,
    closed: isClosedPathData(strip.pathData, strip.closed ?? strip.isClosed),
  }));

  const strips = layout.strips;
  // The generated default circle layout owns a stable synthetic id namespace
  // (`default-outer-circle`, …) that flashed cards address by zone id. It never
  // collided with the artwork layer namespace, so it needs no remap — and
  // renaming it would silently change every default card's zone ids.
  if (isDefaultCircleLayout(strips)) return project;

  const isNamespaced = id => typeof id === 'string' && /^strip-\d+$/.test(id);

  // Seed the sequence past any strips already on the namespace so ids stay unique.
  let seq = 0;
  for (const strip of strips) {
    const match = /^strip-(\d+)$/.exec(strip?.id || '');
    if (match) seq = Math.max(seq, Number(match[1]));
  }

  const oldToNew = new Map();
  for (const strip of strips) {
    if (!strip || typeof strip.id !== 'string' || isNamespaced(strip.id)) continue;
    if (oldToNew.has(strip.id)) continue;
    seq += 1;
    oldToNew.set(strip.id, `strip-${seq}`);
  }
  if (!oldToNew.size) return project;

  // 1. Strip ids. The old id was the strip's source layer/path id, so preserve it
  //    as sourceLayerId where the strip doesn't already record a source.
  for (const strip of strips) {
    const next = oldToNew.get(strip.id);
    if (!next) continue;
    if (strip.sourceLayerId == null && strip.sourcePathId == null) {
      strip.sourceLayerId = strip.id;
    }
    strip.id = next;
  }

  // 2. patchBoard: patch ids (patch-<stripId>[-start-end]), source.stripId, and
  //    chain rowIds (which reference patch ids).
  const board = layout.patchBoard;
  if (board && Array.isArray(board.patches)) {
    const patchIdMap = new Map();
    for (const patch of board.patches) {
      const src = patch?.source;
      if (src?.type !== 'strip' || !oldToNew.has(src.stripId)) continue;
      const oldStripId = src.stripId;
      const newStripId = oldToNew.get(oldStripId);
      const oldPrefix = `patch-${oldStripId}`;
      let newPatchId = patch.id;
      if (patch.id === oldPrefix) {
        newPatchId = `patch-${newStripId}`;
      } else if (typeof patch.id === 'string' && patch.id.startsWith(`${oldPrefix}-`)) {
        newPatchId = `patch-${newStripId}${patch.id.slice(oldPrefix.length)}`;
      }
      if (newPatchId !== patch.id) patchIdMap.set(patch.id, newPatchId);
      patch.id = newPatchId;
      src.stripId = newStripId;
    }
    if (patchIdMap.size && Array.isArray(board.chains)) {
      for (const chain of board.chains) {
        if (Array.isArray(chain.rowIds)) {
          chain.rowIds = chain.rowIds.map(rowId => patchIdMap.get(rowId) ?? rowId);
        }
      }
    }
  }
  const wiring = layout.wiring;
  if (wiring && Array.isArray(wiring.runs)) {
    for (const run of wiring.runs) {
      if (run?.type === 'strip' && oldToNew.has(run.source?.stripId)) run.source.stripId = oldToNew.get(run.source.stripId);
    }
  }

  // 3. Strip group members reference a strip by `stripId`; path members carry no
  //    stripId, so only strip members are remapped. (Their `pathId`/`layerId`
  //    stay the old id — that is exactly the source key.)
  if (Array.isArray(layout.layerGroups)) {
    for (const group of layout.layerGroups) {
      if (!Array.isArray(group?.members)) continue;
      for (const member of group.members) {
        if (member && oldToNew.has(member.stripId)) {
          member.stripId = oldToNew.get(member.stripId);
        }
      }
    }
  }

  // 4. `hidden` is a shared namespace: a legacy strip and its source layer/path
  //    shared one key. Copy the flag onto the new strip key while KEEPING the old
  //    one so the artwork keeps its hidden state (editCounts stays with the layer
  //    and is left untouched).
  if (layout.hidden && typeof layout.hidden === 'object') {
    for (const [oldId, newId] of oldToNew) {
      if (Object.prototype.hasOwnProperty.call(layout.hidden, oldId)) {
        layout.hidden[newId] = layout.hidden[oldId];
      }
    }
  }

  return project;
}

// Canonical migration choke point. A saved chain is physical truth and must
// retain its order; normalization only removes invalid row references and
// synthesizes strip order when no saved physical chain exists.
function alignChainToStripOrder(project) {
  migrateStripIdNamespace(project);
  const layout = project?.layout;
  if (!layout || !Array.isArray(layout.strips)) return project;
  const rawPatchBoard = layout.patchBoard;
  const rawDataWireCount = Number(rawPatchBoard?.dataWireCount);
  const hasExplicitDataWireCount = Number.isInteger(rawDataWireCount) && rawDataWireCount >= 1 && rawDataWireCount <= 4;
  const savedWiringOutputCount = Array.isArray(layout.wiring?.outputs) && layout.wiring.outputs.length
    ? Math.min(4, layout.wiring.outputs.length)
    : 0;
  const configuredOutputCount = (project.devices?.standaloneController?.outputs || [])
    .filter(output => Number(output?.pixels ?? output?.pixelCount) > 0)
    .slice(0, 4)
    .length;
  // Saved wiring outputs are the physical truth. Count metadata is a UI-owned
  // declaration, but it may lag behind an older or partially saved project and
  // must never cause migration to add/remove outputs or remap GPIOs.
  const inferredDataWireCount = savedWiringOutputCount || (hasExplicitDataWireCount
    ? rawDataWireCount
    : configuredOutputCount || DEFAULT_DATA_WIRE_COUNT);
  const ambiguousPhysicalOutputs = !hasExplicitDataWireCount && !savedWiringOutputCount && !configuredOutputCount;
  layout.patchBoard = migrateChainToStripOrder(
    normalizePatchBoard(rawPatchBoard, layout.strips),
    layout.strips,
  );
  layout.wiring = migrateWiring(layout.wiring, layout.strips, layout.patchBoard, {
    pin: project.devices?.standaloneController?.outputs?.[0]?.pin,
    outputs: project.devices?.standaloneController?.outputs,
  });
  // Wiring outputs are the canonical physical declaration. Keep the legacy
  // patch-board metadata synchronized for old saves without allowing a stale
  // duplicate count to recreate, remove, or repin an output.
  layout.patchBoard.dataWireCount = layout.wiring.outputs.length || inferredDataWireCount;
  layout.patchBoard.dataWireCountNeedsReview = rawPatchBoard?.dataWireCountNeedsReview === true || ambiguousPhysicalOutputs;
  if (layout.wiring.outputs.length !== inferredDataWireCount) {
    // Never invent a GPIO/output to make legacy metadata line up. The existing
    // physical topology remains authoritative until the user reviews it.
    layout.patchBoard.dataWireCountNeedsReview = true;
  }
  return project;
}

export function migrateProject(data) {
  if (!data || typeof data !== 'object') return null;
  const base = createDefaultProject();

  if (data.version === PROJECT_VERSION) {
    const pattern = { ...base.pattern, ...(data.pattern || {}) };
    pattern.motionSmoothing = normalizeMotionSmoothing(pattern.motionSmoothing);
    return alignChainToStripOrder({
      ...base,
      ...data,
      id: normalizeProjectId(data.id || data.projectId, base.id),
      layout: {
        ...base.layout,
        ...(data.layout || {}),
        starterPending: data.layout?.starterPending === true,
        wiring: data.layout?.wiring ?? null,
      },
      pattern: { ...pattern, symSettings: { ...base.pattern.symSettings, ...(pattern.symSettings || {}) } },
      show: { ...base.show, ...(data.show || {}) },
      live: { ...base.live, ...(data.live || {}) },
      devices: {
        ...base.devices,
        ...(data.devices || {}),
        physicalControls: normalizeWledPhysicalControls(data.devices?.physicalControls),
        standaloneController: defaultStandaloneController(data.devices?.standaloneController),
      },
    });
  }

  if (data.version === 1 || data.version === 2) {
    return alignChainToStripOrder({
      ...base,
      version: PROJECT_VERSION,
      id: normalizeProjectId(data.id || data.projectId, base.id),
      name: data.name || data.projectName || base.name,
      layout: {
        ...base.layout,
        starterPending: false,
        strips: data.strips || [],
        viewBox: data.viewBox || base.layout.viewBox,
        svgText: data.svgText ?? base.layout.svgText,
        hidden: data.hidden || {},
        layers: data.layers || [],
        density: data.density || base.layout.density,
        pxPerMm: data.pxPerMm || base.layout.pxPerMm,
        editCounts: data.editCounts || {},
        layerGroups: data.layerGroups || [],
        wiring: null,
        layerOrder: data.layerOrder || (data.layers || []).map(l => ({ type: 'layer', id: l.layerId })),
        patchBoard: data.patchBoard || null,
      },
      pattern: {
        ...base.pattern,
        activePatternId: data.activePatternId || base.pattern.activePatternId,
        palette: data.palette?.length ? data.palette : base.pattern.palette,
        masterSpeed: data.masterSpeed ?? base.pattern.masterSpeed,
        masterBrightness: data.masterBrightness ?? base.pattern.masterBrightness,
        masterSaturation: data.masterSaturation ?? base.pattern.masterSaturation,
        masterHueShift: data.masterHueShift ?? base.pattern.masterHueShift,
        gammaEnabled: data.gammaEnabled ?? base.pattern.gammaEnabled,
        gammaValue: data.gammaValue ?? base.pattern.gammaValue,
        patternParams: data.patternParams || {},
        bpm: data.bpm || base.pattern.bpm,
        symSettings: data.symSettings ? { ...base.pattern.symSettings, ...data.symSettings } : base.pattern.symSettings,
        motionSmoothing: normalizeMotionSmoothing(data.motionSmoothing || base.pattern.motionSmoothing),
      },
      show: {
        ...base.show,
        clips: data.showClips || data.clips || base.show.clips,
        transitions: data.showTransitions || data.transitions || base.show.transitions,
        cues: data.showCues || data.cues || base.show.cues,
        autoLanes: data.autoLanes || base.show.autoLanes,
        duration: data.showDuration || data.duration || base.show.duration,
      },
      live: {
        ...base.live,
        quantize: data.liveQuantize || base.live.quantize,
        recording: data.liveRecording || false,
      },
      devices: {
        ...base.devices,
        wledIp: data.wledIp || '',
        segmentMap: data.wledSegmentMap || {},
        physicalControls: normalizeWledPhysicalControls(data.devices?.physicalControls),
        standaloneController: defaultStandaloneController(data.devices?.standaloneController),
      },
    });
  }

  return null;
}

export function resolveStartupProject({
  savedProject = null,
  legacyProject = null,
  legacyLayoutProject = null,
} = {}) {
  const saved = migrateProject(savedProject);
  const legacy = migrateProject(legacyProject);
  const legacyLayout = migrateProject(legacyLayoutProject);
  const project = saved || legacy || createDefaultProject();

  if (!legacyLayout?.layout) return project;

  const projectHasLayout = Array.isArray(project.layout?.strips) &&
    project.layout.strips.length > 0 &&
    !isDefaultCircleLayout(project.layout.strips);
  const legacyHasLayout = Array.isArray(legacyLayout.layout?.strips) && legacyLayout.layout.strips.length > 0;

  if (!projectHasLayout && legacyHasLayout) {
    return {
      ...project,
      layout: {
        ...project.layout,
        ...legacyLayout.layout,
      },
    };
  }

  return project;
}

export function toLegacyProject(project) {
  const p = migrateProject(project);
  if (!p) return null;
  return {
    version: 2,
    projectId: p.id,
    name: p.name,
    ...p.layout,
    activePatternId: p.pattern.activePatternId,
    palette: p.pattern.palette,
    masterSpeed: p.pattern.masterSpeed,
    masterBrightness: p.pattern.masterBrightness,
    masterSaturation: p.pattern.masterSaturation,
    masterHueShift: p.pattern.masterHueShift,
    gammaEnabled: p.pattern.gammaEnabled,
    gammaValue: p.pattern.gammaValue,
    patternParams: p.pattern.patternParams,
    bpm: p.pattern.bpm,
    symSettings: p.pattern.symSettings,
    motionSmoothing: p.pattern.motionSmoothing,
    showClips: p.show.clips,
    showTransitions: p.show.transitions,
    showCues: p.show.cues,
    autoLanes: p.show.autoLanes,
    showDuration: p.show.duration,
    liveQuantize: p.live.quantize,
    liveRecording: p.live.recording,
  };
}
