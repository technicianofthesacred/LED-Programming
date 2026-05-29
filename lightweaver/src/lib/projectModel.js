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
import { createDefaultPatchBoard } from './patchBoard.js';
import { createDefaultCircleLayout, isDefaultCircleLayout } from './defaultCircleLayout.js';

export const PROJECT_VERSION = 3;

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
  return {
    runtimeMode,
    outputs: overrides.outputs || DEFAULT_STANDALONE_OUTPUTS,
    controls: {
      ...DEFAULT_STANDALONE_CONTROLS,
      ...(overrides.controls || {}),
      encoder: {
        ...DEFAULT_STANDALONE_CONTROLS.encoder,
        ...(overrides.controls?.encoder || {}),
      },
    },
    led: {
      ...DEFAULT_STANDALONE_LED,
      ...(overrides.led || {}),
    },
    defaultLook: normalizeCardVisualLook(overrides.defaultLook),
    activeLookId: String(overrides.activeLookId || ''),
    looks: normalizeSavedLooks(overrides.looks || []),
  };
}

export function createDefaultProject() {
  const defaultStrips = createDefaultCircleLayout();
  return {
    version: PROJECT_VERSION,
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

export function migrateProject(data) {
  if (!data || typeof data !== 'object') return null;
  const base = createDefaultProject();

  if (data.version === PROJECT_VERSION) {
    const pattern = { ...base.pattern, ...(data.pattern || {}) };
    pattern.motionSmoothing = normalizeMotionSmoothing(pattern.motionSmoothing);
    return {
      ...base,
      ...data,
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
    };
  }

  if (data.version === 1 || data.version === 2) {
    return {
      ...base,
      version: PROJECT_VERSION,
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
    };
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
