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
  migrateChainToStripOrder,
  normalizePatchBoard,
} from './patchBoard.js';
import { createDefaultCircleLayout, isDefaultCircleLayout } from './defaultCircleLayout.js';
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

// Canonical migration choke point: rebuild the patch-board chain so its wire
// order follows strips[] order (off rows preserved). After this, the chain is
// the sole authority for pixel addressing and can never diverge from strips[].
function alignChainToStripOrder(project) {
  const layout = project?.layout;
  if (!layout || !Array.isArray(layout.strips) || !layout.strips.length) return project;
  if (!layout.patchBoard) return project;
  layout.patchBoard = migrateChainToStripOrder(
    normalizePatchBoard(layout.patchBoard, layout.strips),
    layout.strips,
  );
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
      layout: { ...base.layout, ...(data.layout || {}) },
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
        strips: data.strips || [],
        viewBox: data.viewBox || base.layout.viewBox,
        svgText: data.svgText ?? base.layout.svgText,
        hidden: data.hidden || {},
        layers: data.layers || [],
        density: data.density || base.layout.density,
        pxPerMm: data.pxPerMm || base.layout.pxPerMm,
        editCounts: data.editCounts || {},
        layerGroups: data.layerGroups || [],
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
