import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadJsonFile } from '../lib/downloadFile.js';
import { PATTERN_LAB_BLEND_MODES } from '../lib/patternLabCompositor.js';
import {
  classifyPatternLabCompatibility,
  createPatternLabDiagnosticsSnapshot,
  createPatternLabSimplificationVariant,
} from '../lib/patternLabCompatibility.js';
import { PATTERN_LAB_EVOLUTION_CHARACTERS } from '../lib/patternLabEvolution.js';
import { bakePatternLabRecipe } from '../lib/lwseqBake.js';
import { OFFLINE_AUDIO_CAPABILITY } from '../lib/offlineAudioLanes.js';
import { applyPatternLabHandoff, createPatternLabHandoff } from '../lib/patternLabHandoff.js';
import {
  PATTERN_LAB_GENERATOR_IDS,
  estimatePatternLabGeneratorBudgets,
} from '../lib/patternLabGenerators.js';
import { resolvePatternLabControls } from '../lib/patternLabControls.js';
import { recipeFromPattern } from '../lib/patternLabPatternAdapter.js';
import { normalizePatternLabRecipe, PATTERN_LAB_RECIPE_VERSION } from '../lib/patternLabRecipe.js';
import { readPatternLabDraftState, savePatternLabDraft } from '../lib/patternLabStorage.js';
import { PATTERN_LAB_WORKER_BUDGETS } from '../lib/patternLabWorkerProtocol.js';
import { isBuiltInPattern, listPatterns } from '../lib/patternRegistry.js';
import { useCloudLibrary } from '../state/CloudLibraryContext.jsx';
import { useProject } from '../state/ProjectContext.jsx';
import PatternLabControls from './PatternLabControls.jsx';
import PatternLabDiagnostics from './PatternLabDiagnostics.jsx';
import PatternLabEvolution from './PatternLabEvolution.jsx';
import PatternLabExport from './PatternLabExport.jsx';
import PatternLabPreview from './PatternLabPreview.jsx';
import './pattern-lab.css';

const WORKFLOW = [
  ['Choose', 'Begin with a built-in pattern.', 'Choose a base pattern', <svg viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4z"/><path d="M12 12v4M10 14h4"/></svg>],
  ['Sculpt', 'Shape it with the controls that actually apply to this pattern.', 'Color, brightness, and speed always apply; movement or shape and texture depend on what you picked', <svg viewBox="0 0 24 24"><path d="M4 7h7M15 7h5M4 12h3M11 12h9M4 17h10M18 17h2"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="17" r="2"/></svg>],
  ['Evolve', 'Build a five-to-fifteen-minute journey.', 'Build a long-changing journey', <svg viewBox="0 0 24 24"><path d="M4 14c2-5 4-5 6 0s4 5 6 0 3-4 4-2"/><path d="M4 8h16"/></svg>],
  ['Save', 'Keep a private, repeatable variation.', 'Save this variation privately', <svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 15h8v6H8z"/></svg>],
];
const COMPATIBILITY_OUTCOMES = [
  ['live-on-card', 'Live on card'],
  ['bake-to-card', 'Bake to card'],
  ['simplify-for-card', 'Simplify for card'],
  ['studio-only', 'Studio only'],
];
// Plain-language badge shown next to the promoted project-handoff button.
// Every string here is checked against what createPatternLabHandoff
// (patternLabHandoff.js) actually does for that classification — it must
// never claim a route that createPatternLabHandoff cannot complete today.
//   - live-on-card: handoff succeeds immediately as a saved look.
//   - bake-to-card: handoff succeeds only after a completed bake; there is
//     no live streaming from Studio to fall back on, so the badge points at
//     the recording step instead of inventing one.
//   - simplify-for-card: the recipe itself is not eligible for anything;
//     only a simplified variant (created below) can become native or baked.
//   - studio-only: neither native nor bake-eligible even after
//     simplification. No route exists yet — say so, don't imply recording
//     or streaming will save it.
const COMPATIBILITY_BADGES = {
  'live-on-card': 'Plays on the piece as-is',
  'bake-to-card': 'Can be recorded to the piece',
  'simplify-for-card': 'Too complex for the piece as designed — simplify it to continue',
  'studio-only': "Can't reach the piece yet — plays only in Studio",
};
// What tapping the promoted button actually does per classification. Kept
// next to the badge copy so the two can never drift out of sync with each
// other or with createPatternLabHandoff's real behavior.
const PROMOTED_ACTION_LABELS = {
  'live-on-card': 'Use in Project',
  'bake-to-card': 'Record to piece',
  'simplify-for-card': 'Simplify to continue',
  'studio-only': 'Not ready for the piece',
};
const PROMOTED_ACTION_HINTS = {
  'live-on-card': 'Adds a new saved look to your project right now.',
  'bake-to-card': 'Opens the recording step below — it renders a video of light the card can replay.',
  'simplify-for-card': 'Opens a simplified copy you can create below. Your current design stays unchanged.',
  'studio-only': 'This design can’t reach the piece yet. See Card compatibility & diagnostics below for why.',
};

function compatibilityBadge(compatibility) {
  if (!compatibility) return null;
  return COMPATIBILITY_BADGES[compatibility.classification] || null;
}

function promotedActionLabel(compatibility) {
  if (!compatibility) return 'Use in Project';
  return PROMOTED_ACTION_LABELS[compatibility.classification] || 'Use in Project';
}

function promotedActionHint(compatibility) {
  if (!compatibility) return '';
  return PROMOTED_ACTION_HINTS[compatibility.classification] || '';
}

// -- Piece color -------------------------------------------------------
// The card derives its actual on-wall hue from the middle swatch of
// recipe.palette (lookFromRecipe in patternLabHandoff.js), unconditionally,
// for every pattern. That is the one honest color control: a single hue
// that is always what the piece plays, instead of a 6-swatch editor that
// only 2 of 130 library patterns ever read for their own preview pixels.
// Shifting every swatch by the same hue delta keeps a pattern's original
// relative palette shape (useful for gradient/blocks, which draw every
// swatch) while making the middle swatch land exactly on the picked hue.
function hexToHsl(hex) {
  const clean = String(hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const value = Number.parseInt(full, 16);
  if (full.length !== 6 || !Number.isFinite(value)) return [30, 0.6, 0.5];
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, l];
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, saturation));
  const l = Math.min(1, Math.max(0, lightness));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r0, g0, b0] = h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
      : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c]
          : h < 300 ? [x, 0, c]
            : [c, 0, x];
  const toByte = channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0');
  return `#${toByte(r0)}${toByte(g0)}${toByte(b0)}`;
}

function paletteBaseHue(palette) {
  const swatches = Array.isArray(palette) && palette.length ? palette : ['#f0a04a'];
  const [hue] = hexToHsl(swatches[Math.floor(swatches.length / 2)]);
  return hue;
}

function shiftPaletteHue(palette, targetHueDegrees) {
  const swatches = Array.isArray(palette) && palette.length ? palette : ['#f0a04a'];
  const delta = targetHueDegrees - paletteBaseHue(swatches);
  return swatches.map(hex => {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h + delta, s, l);
  });
}
const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_NODES = 2000;
const MAX_IMPORT_DEPTH = 12;
const PATTERN_LAB_PREVIEW_FPS = PATTERN_LAB_WORKER_BUDGETS.previewFps;
const GENERATOR_NAMES = {
  particles: 'Particle Drift',
  ripple: 'Living Ripples',
  'random-walkers': 'Wandering Trails',
  'cellular-field': 'Cellular Field',
  'gray-scott-1d': 'Reaction Diffusion',
};

function cloneRecipe(recipe) {
  return JSON.parse(JSON.stringify(recipe));
}

function geometryPixelCount(geometry) {
  if (!Array.isArray(geometry?.strips) || geometry.strips.length === 0) return null;
  let count = 0;
  for (const strip of geometry.strips) {
    const value = Array.isArray(strip?.pixels) ? strip.pixels.length : Number(strip?.pixelCount);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    count += value;
    if (!Number.isSafeInteger(count)) return null;
  }
  return count > 0 ? count : null;
}

function visibleGeometryPixelCount(geometry) {
  const visible = (geometry?.strips || []).filter(strip => !geometry?.hidden?.[strip.id]);
  if (!visible.length) return null;
  return geometryPixelCount({ strips: visible });
}

function previewMasterBrightness(recipe, previewTime) {
  return resolvePatternLabControls(recipe, previewTime).effectiveBrightness;
}

function allVisibleStripBrightnessZero(geometry, masterBrightness) {
  const visible = (geometry?.strips || []).filter(strip => !geometry?.hidden?.[strip.id]);
  return visible.length > 0 && visible.every(strip => {
    const stripBrightness = Number(strip?.brightness);
    const normalized = Number.isFinite(stripBrightness) ? stripBrightness : 1;
    return normalized * masterBrightness <= 0.01;
  });
}

function hasKnownStatelessRuntime(recipe) {
  if (recipe?.base?.kind !== 'lightweaver-pattern' || !isBuiltInPattern(recipe.base.patternId)) return false;
  return (recipe.layers || []).every(layer => (
    layer?.generator?.kind === 'lightweaver-pattern'
      && isBuiltInPattern(layer.generator.patternId)
  ));
}

function runtimeMetricsFor(recipe, geometry) {
  const pixelCount = geometryPixelCount(geometry);
  // Empty strings are the classifier's explicit "unknown" input. Supplying
  // every runtime key prevents imported recipe estimates from being trusted.
  const metrics = {
    pixelCount: '',
    fps: PATTERN_LAB_PREVIEW_FPS,
    operationsPerFrame: '',
    stateBytes: '',
    framebufferBytes: '',
  };
  if (pixelCount === null) return metrics;
  metrics.pixelCount = pixelCount;
  metrics.framebufferBytes = pixelCount * 3;
  if (hasKnownStatelessRuntime(recipe)) {
    metrics.stateBytes = 0;
    metrics.operationsPerFrame = pixelCount * 64 * (1 + (recipe.layers?.length || 0));
  } else if (PATTERN_LAB_GENERATOR_IDS.includes(recipe?.base?.kind)) {
    const generator = estimatePatternLabGeneratorBudgets(recipe.base.kind, {
      sampleCount: Math.min(pixelCount, PATTERN_LAB_WORKER_BUDGETS.finalSamples),
      seed: recipe.seed,
    });
    metrics.stateBytes = generator.stateBytes;
    metrics.operationsPerFrame = generator.operationsPerFrame;
  }
  return metrics;
}

function compatibilityFor(recipe, geometry) {
  const metrics = runtimeMetricsFor(recipe, geometry);
  const initial = classifyPatternLabCompatibility(recipe, { metrics });
  if (!initial.simplification?.variant) return initial;
  return classifyPatternLabCompatibility(recipe, {
    metrics,
    simplificationMetrics: runtimeMetricsFor(initial.simplification.variant, geometry),
  });
}

function mappedCoordinate(geometry) {
  const points = (geometry?.strips || []).flatMap(strip => (
    Array.isArray(strip?.pixels) ? strip.pixels : []
  )).filter(point => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)));
  if (!points.length) return {};
  const xs = points.map(point => Number(point.x));
  const ys = points.map(point => Number(point.y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const x = xMax === xMin ? 0.5 : (xs[0] - xMin) / (xMax - xMin);
  const y = yMax === yMin ? 0.5 : (ys[0] - yMin) / (yMax - yMin);
  const offsetX = x - 0.5;
  const offsetY = y - 0.5;
  return {
    x,
    y,
    stripProgress: Number.isFinite(Number(points[0].p)) ? Number(points[0].p) : 0,
    radius: Math.min(1, Math.hypot(offsetX, offsetY) / Math.SQRT1_2),
    angle: (Math.atan2(offsetY, offsetX) + Math.PI) / (Math.PI * 2),
  };
}

function withEvolutionDisabled(recipe) {
  return normalizePatternLabRecipe({
    ...cloneRecipe(recipe),
    evolution: { ...recipe.evolution, enabled: false },
  });
}

function sourceFromRecipe(recipe) {
  const stateful = PATTERN_LAB_GENERATOR_IDS.includes(recipe.base?.kind);
  const source = recipeFromPattern(stateful ? 'aurora' : recipe.base.patternId, {
    ...(Array.isArray(recipe.sourcePalette) ? { palette: recipe.sourcePalette } : {}),
  });
  return withEvolutionDisabled({
    ...source,
    id: recipe.id,
    name: recipe.name,
    sourcePalette: cloneRecipe(recipe.sourcePalette || source.palette),
    ...(stateful ? {
      base: {
        ...cloneRecipe(recipe.base),
        params: { ...cloneRecipe(recipe.base.params || {}), advanced: {} },
      },
    } : {}),
  });
}

function validateImportDocument(value) {
  const errors = [];
  const add = (path, message) => {
    if (errors.length < 4) errors.push(`${path}: ${message}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    add('$', 'must be a recipe object');
    return errors;
  }
  if (![1, PATTERN_LAB_RECIPE_VERSION].includes(Number(value.version))) {
    add('$.version', `must be 1 or ${PATTERN_LAB_RECIPE_VERSION}`);
  }
  if (typeof value.id !== 'string' || !value.id.trim()) add('$.id', 'must be a non-empty string');
  if (!isBuiltInPattern(value.base?.patternId)) add('$.base.patternId', 'must name a built-in Lightweaver pattern');
  if (!PATTERN_LAB_EVOLUTION_CHARACTERS.includes(value.evolution?.character)) {
    add('$.evolution.character', 'must be one of the six supported characters');
  }
  if (!Array.isArray(value.layers) || value.layers.length > 3) {
    add('$.layers', 'must contain at most 3 layers');
  } else {
    value.layers.forEach((layer, index) => {
      const path = `$.layers[${index}]`;
      if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
        add(path, 'must be a layer object');
        return;
      }
      if (typeof layer.id !== 'string' || !layer.id.trim()) add(`${path}.id`, 'must be a non-empty string');
      if (typeof layer.name !== 'string' || !layer.name.trim()) add(`${path}.name`, 'must be a non-empty string');
      if (!PATTERN_LAB_BLEND_MODES.includes(layer.blendMode)) add(`${path}.blendMode`, 'must be a supported blend mode');
      if (!Number.isFinite(Number(layer.opacity)) || Number(layer.opacity) < 0 || Number(layer.opacity) > 1) {
        add(`${path}.opacity`, 'must be between 0 and 1');
      }
    });
  }
  if (Array.isArray(value.targets) && value.targets.length > 64) add('$.targets', 'must contain at most 64 targets');
  if (Array.isArray(value.requirements) && value.requirements.length > 64) add('$.requirements', 'must contain at most 64 entries');
  if (Array.isArray(value.provenance) && value.provenance.length > 64) add('$.provenance', 'must contain at most 64 entries');
  if (value.base?.params && Object.keys(value.base.params).length > 64) add('$.base.params', 'must contain at most 64 parameters');
  if (!Array.isArray(value.palette) || value.palette.length < 2 || value.palette.length > 8) add('$.palette', 'must contain 2 to 8 colors');
  if (!Number.isFinite(Number(value.evolution?.durationSeconds))
    || Number(value.evolution.durationSeconds) < 300
    || Number(value.evolution.durationSeconds) > 900) {
    add('$.evolution.durationSeconds', 'must be between 300 and 900');
  }
  if (!Number.isFinite(Number(value.evolution?.change))
    || Number(value.evolution.change) < 0
    || Number(value.evolution.change) > 1) {
    add('$.evolution.change', 'must be between 0 and 1');
  }

  let nodes = 0;
  const stack = [[value, 0]];
  while (stack.length && errors.length < 4) {
    const [current, depth] = stack.pop();
    nodes += 1;
    if (nodes > MAX_IMPORT_NODES) {
      add('$', `must contain at most ${MAX_IMPORT_NODES} values`);
      break;
    }
    if (depth > MAX_IMPORT_DEPTH) {
      add('$', `must not exceed ${MAX_IMPORT_DEPTH} levels`);
      break;
    }
    if (current && typeof current === 'object') {
      for (const nested of Object.values(current)) stack.push([nested, depth + 1]);
    } else if (typeof current === 'string' && current.length > 20000) {
      add('$', 'contains a string that is too long');
      break;
    }
  }
  return errors;
}

function useMobileDrawer() {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return mobile;
}

function safeFilename(name) {
  const slug = String(name || 'pattern-lab-recipe')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'pattern-lab-recipe'}.lwrecipe.json`;
}

function SculpturePlaceholder() {
  return (
    <svg className="plab-sculpture" viewBox="0 0 640 420" aria-hidden="true" focusable="false">
      <circle className="plab-orbit" cx="320" cy="210" r="164" />
      <circle className="plab-orbit plab-orbit-inner" cx="320" cy="210" r="92" />
      <path className="plab-line" d="M320 45C353 115 443 123 480 210C413 230 397 322 320 375C287 305 197 297 160 210C227 190 243 98 320 45Z" />
      <path className="plab-line plab-line-secondary" d="M160 210C231 246 238 337 320 375C356 304 447 297 480 210C409 174 402 83 320 45C284 116 193 123 160 210Z" />
      <circle className="plab-node" cx="320" cy="45" r="5" />
      <circle className="plab-node" cx="480" cy="210" r="5" />
      <circle className="plab-node" cx="320" cy="375" r="5" />
      <circle className="plab-node" cx="160" cy="210" r="5" />
    </svg>
  );
}

export default function PatternLabScreen() {
  const project = useProject();
  const { workspaceAssets, resolveWorkspaceAssetConflict } = useCloudLibrary();
  const [patterns, setPatterns] = useState([]);
  const importRef = useRef(null);
  const drawerRef = useRef(null);
  const previewStageRef = useRef(null);
  const drawerTriggerRef = useRef(null);
  const drawerCloseRef = useRef(null);
  const sheetScrollRef = useRef(null);
  const screenRef = useRef(null);
  const workspaceRef = useRef(null);
  const sheetDragMovedRef = useRef(false);
  const runtimeToolsRef = useRef(null);
  const [sourceRecipe, setSourceRecipe] = useState(null);
  const [draft, setDraft] = useState(null);
  const [previewTime, setPreviewTime] = useState(0);
  // Open already playing (patternlab-rebuild.md Phase 1: "the preview never
  // pauses itself"). Default true unconditionally, not conditionally on
  // previewRecipe existing yet: the animation effect below already gates on
  // `!playing || !previewRecipe`, so `playing: true` with no recipe is inert
  // (nothing to animate, Play button stays disabled). The moment a recipe
  // appears — choosePattern, openDraft, importRecipe, useDraftVariant — this
  // flag is already true, so the preview starts moving with no extra
  // setPlaying(true) call and no chance of a race between "recipe arrived"
  // and "start playing" firing in the wrong order.
  const [playing, setPlaying] = useState(true);
  const [drafts, setDrafts] = useState([]);
  const [draftState, setDraftState] = useState('loading');
  const [message, setMessage] = useState('');
  const [importErrors, setImportErrors] = useState([]);
  // The phone control sheet is a three-detent sheet, not a fixed 82%-tall
  // modal drawer (todo/plans/patternlab-rebuild.md §5, §7 Phase 2). The owner
  // could not "get real tangible designs or play" because reaching any slider
  // meant opening a sheet that covered the artwork AND marked the preview
  // `inert` — you could move a control or watch the art, never both.
  //
  //   closed — off screen, aria-hidden + inert (unchanged; this is what
  //            `openControls()` in tests/helpers/pattern-lab.ts opens).
  //   peek   — the play strip: the sliders sit under a live, fully visible,
  //            NON-inert preview. This is where a pattern choice lands you.
  //   half   — same non-modal contract, taller, for the depth controls.
  //   full   — the browser/library/save view. The only detent allowed to be
  //            modal, because at that height the artwork is behind the sheet
  //            anyway and a focus trap is then the honest behaviour.
  const [sheetDetent, setSheetDetent] = useState('closed');
  const [activeWorkflowStep, setActiveWorkflowStep] = useState(0);
  const [instrumentResponse, setInstrumentResponse] = useState({
    sequence: 0,
    kind: null,
    step: 0,
    patternSequence: 0,
  });
  const [previewFrameSignals, setPreviewFrameSignals] = useState({
    recipeId: null,
    frameObserved: false,
    sampledPixelCount: null,
    blackPixelCount: null,
  });
  const mobileDrawer = useMobileDrawer();
  const drawerOpen = sheetDetent !== 'closed';
  // Modal-ness is a property of ONE detent, not of "the drawer is open".
  // Everything downstream — the preview's `inert`, the dismiss backdrop, the
  // focus trap, aria-modal — keys off this single flag so they cannot drift
  // apart into a sheet that traps focus without a backdrop, or dims the
  // screen without disabling it.
  const sheetModal = mobileDrawer && sheetDetent === 'full';
  const previewRecipe = draft;
  const previewDuration = draft?.evolution?.durationSeconds ?? 600;

  useEffect(() => {
    if (!workspaceAssets.ready) return;
    setPatterns(listPatterns());
    const state = readPatternLabDraftState();
    setDrafts(state.drafts);
    setDraftState(state.status === 'empty' || state.status === 'restored' ? 'ready' : state.status);
  }, [workspaceAssets.generation, workspaceAssets.ready]);

  useEffect(() => {
    if (!playing || !previewRecipe) return undefined;
    let frame = 0;
    let lastCommit = performance.now();
    const advance = now => {
      if (now - lastCommit >= 30) {
        const elapsed = Math.min((now - lastCommit) / 1000, 0.1);
        setPreviewTime(current => (current + elapsed) % previewDuration);
        lastCommit = now;
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [playing, previewDuration, Boolean(previewRecipe)]);

  useEffect(() => {
    if (!mobileDrawer || !drawerOpen) return undefined;
    // Reopening starts at the top of the control column. Before this, the
    // sheet reappeared wherever it was last scrolled to — usually deep in the
    // diagnostics accordion — so "open controls" showed a random slice of the
    // screen instead of the pattern browser. Deliberately keyed on
    // closed -> open only (`drawerOpen`), so moving between detents keeps the
    // owner's scroll position.
    if (sheetScrollRef.current) sheetScrollRef.current.scrollTop = 0;
    drawerCloseRef.current?.focus();
    const closeOnEscape = event => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen, mobileDrawer]);

  // The control sheet is anchored to the viewport, but the artwork it must
  // not cover ends at the workspace's bottom edge — the Studio status bar
  // sits between the two. Publish that measured strip so the CSS can shrink
  // the preview by the OVERLAP rather than by the sheet's whole height; the
  // naive version leaves a phone with a 0px-tall stage.
  useEffect(() => {
    if (!mobileDrawer) {
      screenRef.current?.style.removeProperty('--plab-sheet-gap');
      return undefined;
    }
    const measure = () => {
      const workspace = workspaceRef.current;
      const screen = screenRef.current;
      if (!workspace || !screen) return;
      const gap = Math.max(0, Math.round(window.innerHeight - workspace.getBoundingClientRect().bottom));
      screen.style.setProperty('--plab-sheet-gap', `${gap}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [mobileDrawer, sheetDetent, draftState]);

  const geometry = useMemo(() => ({
    strips: project.strips.map(strip => {
      const { patternId: _patternId, compiledFn: _compiledFn, patternFn: _patternFn, ...geometryStrip } = strip;
      return { ...geometryStrip, patternId: null };
    }),
    viewBox: project.viewBox,
    svgText: project.svgText,
    hidden: project.hidden,
    bpm: project.bpm,
    gammaEnabled: project.gammaEnabled,
    gammaValue: project.gammaValue,
    symSettings: project.symSettings,
    audioBands: project.audioBands,
    motionSmoothing: project.motionSmoothing,
  }), [
    project.strips,
    project.viewBox,
    project.svgText,
    project.hidden,
    project.bpm,
    project.gammaEnabled,
    project.gammaValue,
    project.symSettings,
    project.audioBands,
    project.motionSmoothing,
  ]);

  useEffect(() => {
    const root = previewStageRef.current;
    const recipeId = previewRecipe?.id ?? null;
    setPreviewFrameSignals({
      recipeId,
      frameObserved: false,
      sampledPixelCount: null,
      blackPixelCount: null,
    });
    if (!root || !recipeId) return undefined;

    const scratch = document.createElement('canvas');
    scratch.width = 64;
    scratch.height = 64;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    let timeout = 0;
    let disposed = false;
    let remainingAttempts = 4;

    const inspect = () => {
      timeout = 0;
      if (disposed || !context) return;
      const preview = root.querySelector('[data-testid="pattern-lab-mapped-preview"]');
      const canvas = preview?.querySelector('canvas');
      const glowCanvas = canvas?._glow;
      const sampledPixelCount = visibleGeometryPixelCount(geometry);
      if (!glowCanvas?.width || !glowCanvas?.height || sampledPixelCount === null) {
        if (remainingAttempts > 0) {
          remainingAttempts -= 1;
          timeout = window.setTimeout(inspect, 320);
        }
        return;
      }
      try {
        context.clearRect(0, 0, scratch.width, scratch.height);
        context.drawImage(glowCanvas, 0, 0, scratch.width, scratch.height);
        const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
        let hasVisibleOutput = false;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] > 0) {
            hasVisibleOutput = true;
            break;
          }
        }
        setPreviewFrameSignals(current => {
          const next = {
            recipeId,
            frameObserved: true,
            sampledPixelCount,
            blackPixelCount: hasVisibleOutput ? null : sampledPixelCount,
          };
          return current.recipeId === next.recipeId
            && current.frameObserved === next.frameObserved
            && current.sampledPixelCount === next.sampledPixelCount
            && current.blackPixelCount === next.blackPixelCount
            ? current
            : next;
        });
      } catch {
        // Canvas telemetry is optional. Leave the frame signals unknown when
        // the browser refuses a pixel read rather than inventing a cause.
      }
    };
    const scheduleInspection = () => {
      if (timeout) return;
      timeout = window.setTimeout(inspect, 320);
    };
    const observer = new MutationObserver(scheduleInspection);
    observer.observe(root, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-worker-frame-id', 'data-worker-state'],
    });
    scheduleInspection();
    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [geometry, previewRecipe]);

  const runtimeMetrics = useMemo(
    () => draft ? runtimeMetricsFor(draft, geometry) : null,
    [draft, geometry],
  );
  const compatibility = useMemo(
    () => draft ? compatibilityFor(draft, geometry) : null,
    [draft, geometry],
  );
  const diagnosticMasterBrightness = draft ? previewMasterBrightness(draft, previewTime) : 1;
  const diagnosticFrameSignals = previewFrameSignals.recipeId === draft?.id
    ? previewFrameSignals
    : { frameObserved: false, sampledPixelCount: null, blackPixelCount: null };
  const diagnostics = useMemo(() => (
    draft
      && Number.isSafeInteger(runtimeMetrics?.stateBytes)
      && Number.isSafeInteger(runtimeMetrics?.framebufferBytes)
  ) ? createPatternLabDiagnosticsSnapshot({
    paused: !playing,
    frameIndex: Math.round(previewTime * PATTERN_LAB_PREVIEW_FPS),
    coordinates: mappedCoordinate(geometry),
    fps: PATTERN_LAB_PREVIEW_FPS,
    frameTimeMs: 1000 / PATTERN_LAB_PREVIEW_FPS,
    stateBytes: runtimeMetrics?.stateBytes,
    framebufferBytes: runtimeMetrics?.framebufferBytes,
    state: {
      recipeId: draft.id,
      seed: draft.seed,
      evolution: draft.evolution?.character,
      signals: {
        frameObserved: diagnosticFrameSignals.frameObserved,
        blackPixelCount: diagnosticFrameSignals.blackPixelCount ?? 'unknown',
        invalidOutputCount: 'unknown',
        gammaInput: project.gammaEnabled ? 'unknown' : 'not-enabled',
        powerLimited: 'unknown',
        maskAlpha: (draft.layers || []).some(layer => layer?.mask) ? 'unknown' : 'not-present',
        zeroOpacityLayerCount: (draft.layers || []).filter(layer => Number(layer?.opacity) <= 0.01).length,
      },
    },
    darkness: {
      brightness: diagnosticMasterBrightness,
      allStripBrightnessZero: allVisibleStripBrightnessZero(geometry, diagnosticMasterBrightness),
      frameObserved: diagnosticFrameSignals.frameObserved,
      sampledPixelCount: diagnosticFrameSignals.sampledPixelCount,
      blackPixelCount: diagnosticFrameSignals.blackPixelCount,
      targetMatched: (draft.targets || []).every(target => target?.kind === 'whole-piece'),
    },
  }) : null, [
    diagnosticFrameSignals,
    diagnosticMasterBrightness,
    draft,
    geometry,
    playing,
    previewTime,
    project.gammaEnabled,
    runtimeMetrics,
  ]);

  function signalInstrumentResponse(step, kind = 'control') {
    setActiveWorkflowStep(step);
    setInstrumentResponse(current => ({
      sequence: current.sequence + 1,
      kind,
      step,
      patternSequence: current.patternSequence + (kind === 'pattern' ? 1 : 0),
    }));
  }

  function activateInspectorStep(event) {
    const section = event.target.closest?.('[data-workflow-step]');
    const step = Number(section?.dataset.workflowStep);
    if (Number.isInteger(step) && step >= 0 && step <= 2) setActiveWorkflowStep(step);
  }

  function choosePattern(patternId) {
    if (!patternId) {
      setSourceRecipe(null);
      setDraft(null);
      setActiveWorkflowStep(0);
      return;
    }
    const generatorId = patternId.startsWith('generator:') ? patternId.slice('generator:'.length) : '';
    const stateful = PATTERN_LAB_GENERATOR_IDS.includes(generatorId);
    const selected = stateful
      ? withEvolutionDisabled({
          ...recipeFromPattern('aurora', { palette: project.palette }),
          name: GENERATOR_NAMES[generatorId],
          base: { kind: generatorId, patternId: 'aurora', params: { advanced: {} } },
        })
      : withEvolutionDisabled(recipeFromPattern(patternId, { palette: project.palette }));
    const source = { ...selected, sourcePalette: cloneRecipe(selected.palette) };
    setSourceRecipe(source);
    setDraft(cloneRecipe(source));
    setPreviewTime(0);
    setMessage('');
    setImportErrors([]);
    signalInstrumentResponse(0, 'pattern');
    settleSheetOnSculpt();
  }

  function changeMacro(name, value) {
    setDraft(current => current ? { ...current, macros: { ...current.macros, [name]: value } } : current);
    setMessage('');
    signalInstrumentResponse(1);
  }

  function changePlayback(name, value) {
    setDraft(current => current ? { ...current, playback: { ...current.playback, [name]: value } } : current);
    setMessage('');
    signalInstrumentResponse(1);
  }

  function changeAdvanced(name, value) {
    setDraft(current => current ? {
      ...current,
      base: {
        ...current.base,
        params: {
          ...current.base.params,
          advanced: { ...current.base.params?.advanced, [name]: value },
        },
      },
    } : current);
    setMessage('');
    signalInstrumentResponse(1);
  }

  function changeParam(name, value) {
    setDraft(current => current ? {
      ...current,
      base: {
        ...current.base,
        params: { ...current.base.params, [name]: value },
      },
    } : current);
    setMessage('');
    signalInstrumentResponse(1);
  }

  function changePieceColor(hueDegrees) {
    setDraft(current => current ? { ...current, palette: shiftPaletteHue(current.palette, hueDegrees) } : current);
    setMessage('');
    signalInstrumentResponse(1);
  }

  function changeEvolution(name, value) {
    setDraft(current => current ? { ...current, evolution: { ...current.evolution, [name]: value } } : current);
    if (name === 'durationSeconds') setPreviewTime(current => Math.min(current, value));
    setMessage('');
    signalInstrumentResponse(2);
  }

  function changeAudioAnalysis(analysis, requirement) {
    setDraft(current => {
      if (!current) return current;
      const requirements = (current.requirements || []).filter(item => (
        item?.capability !== OFFLINE_AUDIO_CAPABILITY
      ));
      if (!analysis || !requirement) {
        const { offlineAudio: _offlineAudio, ...withoutAudio } = current;
        return { ...withoutAudio, requirements };
      }
      return {
        ...current,
        offlineAudio: cloneRecipe(analysis),
        requirements: [...requirements, cloneRecipe(requirement)],
      };
    });
    setMessage('');
    signalInstrumentResponse(2);
  }

  function changePreviewTime(value) {
    setPreviewTime(value);
    signalInstrumentResponse(2);
  }

  function closeDrawer() {
    setSheetDetent('closed');
    requestAnimationFrame(() => drawerTriggerRef.current?.focus());
  }

  function toggleDrawer() {
    if (drawerOpen) closeDrawer();
    // "Controls" is the open-everything affordance: it lands on the browser,
    // the drafts and the save actions, which only exist at full height.
    else setSheetDetent('full');
  }

  // Choosing a pattern drops the sheet to the play strip: the artwork is back
  // in full view, still running, with Brightness / Speed / Color under it. No
  // gesture is needed to get from "I picked this" to "I can play with it".
  function settleSheetOnSculpt() {
    if (!mobileDrawer) return;
    setSheetDetent('peek');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const heading = document.getElementById('plab-sculpt-heading');
      const section = heading?.closest('.plab-control-section') || heading;
      section?.scrollIntoView({ block: 'start' });
      // Focus follows the sheet rather than staying on a tile that the peek
      // detent has just scrolled out of view — the non-modal replacement for
      // the focus trap, which only ran because the sheet used to be modal.
      heading?.focus({ preventScroll: true });
    }));
  }

  function detentForHeight(height) {
    const viewport = typeof window === 'undefined' ? 1 : (window.innerHeight || 1);
    const ratio = height / viewport;
    if (ratio < 0.58) return 'peek';
    if (ratio < 0.79) return 'half';
    return 'full';
  }

  // Changing detent must not throw away what the owner was looking at. The
  // sheet's content is one tall scroller, so a taller sheet reveals sections
  // ABOVE the current scroll position and pushes the sliders off the bottom
  // unless the top-most visible section is re-pinned to the top afterwards.
  function withSheetAnchor(mutate) {
    const scroller = sheetScrollRef.current;
    let anchor = null;
    if (scroller) {
      const top = scroller.getBoundingClientRect().top + 4;
      anchor = [...scroller.querySelectorAll('.plab-control-section, .plab-private-library')]
        .find(node => node.getBoundingClientRect().bottom > top) || null;
    }
    mutate();
    if (!anchor) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      anchor.scrollIntoView({ block: 'start' });
    }));
  }

  function cycleSheetDetent() {
    // A drag that actually moved already chose a detent; the trailing click
    // must not advance it again.
    if (sheetDragMovedRef.current) {
      sheetDragMovedRef.current = false;
      return;
    }
    withSheetAnchor(() => setSheetDetent(current => {
      if (current === 'closed') return current;
      if (current === 'peek') return 'half';
      return current === 'half' ? 'full' : 'peek';
    }));
  }

  function beginSheetDrag(event) {
    if (!mobileDrawer || !drawerRef.current || event.button > 0) return;
    const startY = event.clientY;
    const startHeight = drawerRef.current.getBoundingClientRect().height;
    sheetDragMovedRef.current = false;
    const move = moveEvent => {
      const delta = startY - moveEvent.clientY;
      if (!sheetDragMovedRef.current && Math.abs(delta) < 8) return;
      sheetDragMovedRef.current = true;
      const next = detentForHeight(startHeight + delta);
      withSheetAnchor(() => setSheetDetent(current => (current === 'closed' ? current : next)));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // The Choose step is the tile browser's search field, not a native
  // <select>, so "opening the picker" is just moving focus there — the tile
  // grid underneath is already visible, there is no dropdown to trigger.
  function openPatternPicker(target) {
    if (!target) return;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }

  function openWorkflowStep(index) {
    setActiveWorkflowStep(index);
    // Step 0 is the pattern browser, which only exists at full height; the
    // other three are reachable at whatever detent the owner is already on,
    // so a tap on "Sculpt" from the play strip does not swallow the artwork.
    if (mobileDrawer) {
      setSheetDetent(current => (current === 'closed' || index === 0 ? 'full' : current));
    }
    const targetId = [
      'plab-base-pattern',
      'plab-sculpt-heading',
      'plab-evolution-heading',
      'plab-save-private',
    ][index];
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (index === 0) openPatternPicker(target);
      else {
        target?.scrollIntoView({ block: 'nearest' });
        target?.focus({ preventScroll: true });
      }
    }));
  }

  function trapDrawerFocus(event) {
    // A focus trap belongs to a modal, and only the full detent is modal.
    // At peek and half the sheet is a non-modal companion to a live preview:
    // Tab walks out of it into the play button and the artwork, which is the
    // whole point of the redesign.
    if (!sheetModal || event.key !== 'Tab') return;
    const focusable = [...drawerRef.current.querySelectorAll(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [href], [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function useDraftVariant(variant, status) {
    if (!variant) return;
    const next = normalizePatternLabRecipe(cloneRecipe(variant));
    setDraft(next);
    setPreviewTime(0);
    setMessage(`${status} ${next.name}. The source recipe is unchanged.`);
  }

  function simplifyForCard(variant) {
    useDraftVariant(variant, 'Created');
  }

  function removeUnsupportedFeatures(removals) {
    if (!draft || !Array.isArray(removals) || !removals.length) return;
    const variant = createPatternLabSimplificationVariant(draft, removals, {
      id: `${draft.id}-cleanup`,
      name: `${draft.name} — Cleanup variant`,
    });
    useDraftVariant(variant, 'Created');
  }

  function pauseDiagnostics(paused) {
    setPlaying(!paused);
  }

  function stepDiagnosticsFrame() {
    setPlaying(false);
    setPreviewTime(current => (current + (1 / PATTERN_LAB_PREVIEW_FPS)) % previewDuration);
  }

  function openDraft(saved) {
    const normalized = normalizePatternLabRecipe(saved);
    setSourceRecipe(sourceFromRecipe(normalized));
    setDraft(cloneRecipe(normalized));
    setPreviewTime(0);
    setMessage(`Opened ${normalized.name}`);
    setImportErrors([]);
  }

  function saveDraft() {
    if (!draft) return;
    try {
      const saved = savePatternLabDraft(normalizePatternLabRecipe(draft));
      setDraft(saved);
      const state = readPatternLabDraftState();
      setDrafts(state.drafts);
      setDraftState(state.status === 'empty' || state.status === 'restored' ? 'ready' : state.status);
      setMessage(`Saved privately — ${saved.name}`);
      setActiveWorkflowStep(3);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save this private draft.');
    }
  }

  async function exportRecipe() {
    if (!draft) return;
    try {
      const canonical = normalizePatternLabRecipe(draft);
      const exported = await downloadJsonFile(safeFilename(canonical.name), canonical, { preferPicker: false });
      setMessage(exported ? `Exported ${canonical.name}` : 'Export was canceled. Nothing was downloaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not export this recipe.');
    }
  }

  async function bakeForCard(_compatibility, { signal } = {}) {
    if (!draft) throw new TypeError('Choose a Pattern Lab recipe before baking.');
    return bakePatternLabRecipe({
      recipe: draft,
      strips: project.strips,
      groups: project.layoutLayerGroups,
      wiring: project.wiring,
      hidden: project.hidden,
      audioLanes: draft.offlineAudio,
      render: {
        bpm: project.bpm,
        gammaEnabled: project.gammaEnabled,
        gammaValue: project.gammaValue,
        symSettings: project.symSettings,
      },
      signal,
    });
  }

  async function useInProject({ bakeResult = null } = {}) {
    if (!draft || !compatibility) {
      return { ok: false, message: 'Choose and validate a Pattern Lab recipe first.' };
    }
    const result = await createPatternLabHandoff({
      recipe: draft,
      compatibility,
      bakeResult,
      controller: project.standaloneController,
    });
    if (result.kind === 'blocked') {
      return {
        ok: false,
        message: result.reasons?.[0]?.message || 'This pattern is not ready to add to the project.',
      };
    }
    const nextController = await applyPatternLabHandoff(project.standaloneController, result);
    if (nextController === project.standaloneController) {
      return { ok: false, message: 'The project rejected this addition. Nothing was changed.' };
    }
    const applied = project.setStandaloneController(nextController);
    if (applied?.ok !== true) {
      const firstError = applied?.errors?.[0];
      return {
        ok: false,
        message: (typeof firstError === 'string' ? firstError : firstError?.message)
          || 'The project could not accept this addition. Nothing was changed.',
      };
    }
    if (result.kind === 'sequence') {
      const downloaded = await downloadJsonFile(
        `${result.asset.id}.lightweaver-controller.json`,
        result.package,
        { preferPicker: false },
      );
      return {
        ok: true,
        message: downloaded
          ? `Added ${result.asset.label} as a sequence asset and downloaded its verified controller package.`
          : `Added ${result.asset.label} as a sequence asset. Download its controller package again before loading the card.`,
      };
    }
    return { ok: true, message: `Added and selected ${result.look.label} in the project.` };
  }

  // Promoted top-level entry point for the project-handoff badge. Only
  // "live-on-card" can succeed as a genuine one tap: createPatternLabHandoff
  // returns blocked('bake-required') for "bake-to-card" without a completed
  // bake, and has no direct path at all for "simplify-for-card" or
  // "studio-only". So this button only calls the handoff for the case that
  // can actually complete; every other classification reveals the "Card
  // compatibility & diagnostics" section, where the real recording /
  // simplify flow lives, instead of promising a one-click add it cannot
  // deliver.
  function openRuntimeTools() {
    const node = runtimeToolsRef.current;
    if (!node) return;
    node.open = true;
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'nearest' });
      node.querySelector('summary')?.focus();
    });
  }

  async function useInProjectPrimary() {
    if (!draft || !compatibility) return;
    if (compatibility.classification !== 'live-on-card') {
      openRuntimeTools();
      return;
    }
    setMessage('Adding to project…');
    try {
      const result = await useInProject();
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not add this pattern to the project.');
    }
  }

  async function importRecipe(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        setImportErrors([`file: must be smaller than ${Math.round(MAX_IMPORT_BYTES / 1024)} KB`]);
        setMessage('');
        return;
      }
      const temporary = JSON.parse(await file.text());
      const validationErrors = validateImportDocument(temporary);
      if (validationErrors.length) {
        setImportErrors(validationErrors);
        setMessage('');
        return;
      }
      const normalized = normalizePatternLabRecipe(temporary);
      const source = sourceFromRecipe(normalized);
      setSourceRecipe(source);
      setDraft(cloneRecipe(normalized));
      setPreviewTime(0);
      setImportErrors([]);
      setMessage(`Imported ${normalized.name}. Save when you want to keep it privately.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The file is not a valid Pattern Lab recipe.';
      setImportErrors([detail].slice(0, 4));
      setMessage('');
    }
  }

  return (
    <main
      className="screen plab-screen"
      data-testid="pattern-lab-screen"
      data-sheet-detent={mobileDrawer ? sheetDetent : "desktop"}
      ref={screenRef}
    >
      <div className="plab-scroll">
        <header className="plab-toolbar" data-testid="pattern-lab-toolbar" inert={sheetModal ? '' : undefined}>
          <div className="plab-toolbar-identity">
            <svg className="plab-toolbar-mark" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6M10 3v5l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/>
              <path d="M7.8 15h8.4"/>
            </svg>
            <h1>Pattern Lab</h1>
            <span
              className="plab-private-status"
              role="status"
              aria-label="Private workspace. Your project and lights stay unchanged."
              title="Private workspace: your project and lights stay unchanged"
              data-tooltip="Private workspace: your project and lights stay unchanged"
              data-tooltip-align="start"
            >
              <span aria-hidden="true" />
            </span>
          </div>
          <nav className="plab-workflow" aria-label="Pattern Lab workflow">
            {WORKFLOW.map(([title, description, tooltip, icon], index) => (
              <button
                key={title}
                type="button"
                className="plab-workflow-step"
                aria-label={title}
                aria-current={activeWorkflowStep === index ? 'step' : undefined}
                title={`${title}: ${description}`}
                data-tooltip={tooltip}
                data-tooltip-align={index > 0 ? 'end' : undefined}
                onClick={() => openWorkflowStep(index)}
              >
                <span className="plab-step-icon" aria-hidden="true">{icon}</span>
              </button>
            ))}
          </nav>
        </header>

        <section className="plab-workspace" aria-label="Pattern authoring workspace" ref={workspaceRef}>
          <div className="plab-preview" inert={sheetModal ? '' : undefined}>
            <div className="plab-preview-bar">
              <span>{previewRecipe ? <strong data-testid="pattern-lab-draft-name">{previewRecipe.name}</strong> : 'Artwork preview'}</span>
              <div className="plab-preview-meta">
                <span>{previewRecipe ? 'Mapped to current artwork' : 'No source selected'}</span>
                <button type="button" className="plab-play" disabled={!previewRecipe} aria-pressed={playing} onClick={() => setPlaying(value => !value)}>{playing ? 'Pause' : 'Play'}</button>
                <button
                  ref={drawerTriggerRef}
                  type="button"
                  className="plab-drawer-trigger"
                  aria-label="Pattern controls"
                  aria-expanded={drawerOpen}
                  aria-controls="plab-controls-drawer"
                  onClick={toggleDrawer}
                >Controls</button>
              </div>
            </div>
            <div className="plab-stage" ref={previewStageRef}>
              {previewRecipe ? (
                <div
                  key={`pattern-${instrumentResponse.patternSequence}`}
                  className={`plab-preview-content${instrumentResponse.patternSequence > 0 ? ' is-pattern-transition' : ''}`}
                  data-testid="pattern-lab-preview-content"
                  data-pattern-transition={instrumentResponse.patternSequence > 0 ? 'true' : 'false'}
                >
                  <PatternLabPreview
                    recipe={previewRecipe}
                    previewTime={previewTime}
                    playing={playing}
                    geometry={geometry}
                    fallbackLook={project.standaloneController?.defaultLook}
                  />
                </div>
              ) : (
                <>
                  <SculpturePlaceholder />
                  <div className="plab-empty">
                    <span className="plab-empty-rule" aria-hidden="true" />
                    <h2>Begin with a pattern</h2>
                    <p>Choose a built-in look in the inspector. Pattern Lab makes a private copy you can stretch into a longer, less repetitive experience.</p>
                    <button type="button" className="btn primary" onClick={() => {
                      setActiveWorkflowStep(0);
                      if (mobileDrawer) setSheetDetent('full');
                      requestAnimationFrame(() => requestAnimationFrame(() => {
                        openPatternPicker(document.getElementById('plab-base-pattern'));
                      }));
                    }}>Choose pattern</button>
                  </div>
                </>
              )}
              {instrumentResponse.sequence > 0 && (
                <span
                  key={instrumentResponse.sequence}
                  className="plab-preview-response"
                  data-testid="pattern-lab-preview-response"
                  data-response-kind={instrumentResponse.kind}
                  data-response-sequence={instrumentResponse.sequence}
                  aria-hidden="true"
                />
              )}
            </div>
          </div>

          {sheetModal && (
            <button className="plab-drawer-backdrop" type="button" aria-label="Dismiss pattern controls" onClick={closeDrawer} />
          )}
          <aside
            ref={drawerRef}
            id="plab-controls-drawer"
            className={`plab-controls${drawerOpen ? ' drawer-open' : ''}`}
            aria-label="Pattern Lab controls"
            data-detent={mobileDrawer ? sheetDetent : undefined}
            role={mobileDrawer ? 'dialog' : undefined}
            aria-modal={mobileDrawer && drawerOpen ? (sheetModal ? 'true' : 'false') : undefined}
            aria-hidden={mobileDrawer && !drawerOpen ? 'true' : undefined}
            inert={mobileDrawer && !drawerOpen ? '' : undefined}
            onFocusCapture={activateInspectorStep}
            onPointerDownCapture={activateInspectorStep}
            onKeyDown={trapDrawerFocus}
          >
            {mobileDrawer && (
              <button
                type="button"
                className="plab-sheet-handle"
                aria-label="Adjust the controls sheet height"
                title={`Controls sheet: ${sheetDetent}. Drag or tap to resize.`}
                data-testid="pattern-lab-sheet-handle"
                onPointerDown={beginSheetDrag}
                onClick={cycleSheetDetent}
              ><span aria-hidden="true" /></button>
            )}
            <div className="plab-control-heading">
              <span>Pattern inspector</span>
              <span>{draft ? 'Private draft' : 'Choose below'}</span>
              <button
                ref={drawerCloseRef}
                type="button"
                className="plab-drawer-close"
                aria-label="Close pattern controls"
                onClick={closeDrawer}
              >Close</button>
            </div>
            {/* On a phone the sheet is a flex column: handle, heading, this
                scroller, then the action bar as a sibling rather than an
                overlay — so the save row can no longer sit on top of the last
                section. `display: contents` above the breakpoint keeps the
                desktop two-pane column byte-identical to what it was. */}
            <div className="plab-sheet-scroll" ref={sheetScrollRef}>
            <div id="plab-pattern-select">
              <PatternLabControls
                patterns={patterns}
                recipe={draft}
                selectedPatternId={PATTERN_LAB_GENERATOR_IDS.includes(draft?.base?.kind)
                  ? `generator:${draft.base.kind}`
                  : draft?.base?.patternId || ''}
                onPatternChange={choosePattern}
                onMacroChange={changeMacro}
                onPlaybackChange={changePlayback}
                onPieceColorChange={changePieceColor}
                pieceColorHue={draft ? paletteBaseHue(draft.palette) : 30}
                onAdvancedChange={changeAdvanced}
                onParamChange={changeParam}
                activeWorkflowStep={activeWorkflowStep}
                instrumentResponse={instrumentResponse}
              />
            </div>
            <PatternLabEvolution
              recipe={draft}
              previewTime={previewTime}
              onEvolutionChange={changeEvolution}
              onPreviewTime={changePreviewTime}
              onAudioAnalysis={changeAudioAnalysis}
              activeWorkflowStep={activeWorkflowStep}
              instrumentResponse={instrumentResponse}
            />

            {draft && (
              <details
                ref={runtimeToolsRef}
                className="plab-runtime-tools"
                data-testid="pattern-lab-runtime-tools"
                data-source-recipe-id={sourceRecipe?.id}
                data-draft-recipe-id={draft.id}
                data-preview-time={previewTime}
                data-source-recipe-snapshot={JSON.stringify(sourceRecipe)}
              >
                <summary>Card compatibility &amp; diagnostics</summary>
                <div className="plab-runtime-tools-body">
                  <ul className="plab-compatibility-outcomes" aria-label="Card compatibility outcomes">
                    {COMPATIBILITY_OUTCOMES.map(([classification, label]) => (
                      <li
                        key={classification}
                        aria-current={compatibility?.classification === classification ? 'true' : undefined}
                      >{label}</li>
                    ))}
                  </ul>
                  <PatternLabExport
                    compatibility={compatibility}
                    recipe={draft}
                    onBake={bakeForCard}
                    onUseInProject={useInProject}
                    onSimplify={simplifyForCard}
                    onRemoveFeature={removeUnsupportedFeatures}
                  />
                  {compatibility?.simplification?.variant
                    && compatibility.simplification.resolvesCompatibility !== true && (
                    <div className="plab-runtime-cleanup">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => useDraftVariant(compatibility.simplification.variant, 'Created')}
                      >Create cleanup variant</button>
                      <small>This keeps the source intact, but the new draft remains Studio only until every unknown is measured.</small>
                    </div>
                  )}
                  <PatternLabDiagnostics
                    diagnostics={diagnostics}
                    onPause={pauseDiagnostics}
                    onFrameStep={stepDiagnosticsFrame}
                  />
                </div>
              </details>
            )}

            {workspaceAssets.conflict && (
              <div className="plab-import-errors" role="alert">
                <strong>Workspace patterns changed on another device.</strong>
                <p>Keep the online version and preserve this device&apos;s colliding work as named local copies.</p>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => resolveWorkspaceAssetConflict('keep-both')}
                >Keep both copies</button>
              </div>
            )}

            <section className="plab-private-library" aria-labelledby="plab-private-heading">
              <div className="plab-library-heading">
                <div><span className="plab-section-index">Saved</span><h2 id="plab-private-heading">Private drafts</h2></div>
                <span>{drafts.length}</span>
              </div>
              {draftState === 'loading' && <p>Loading private drafts…</p>}
              {draftState === 'unavailable' && <p role="alert">Private draft storage is unavailable in this browser.</p>}
              {draftState === 'unrecoverable' && <p role="alert">Private drafts could not be recovered. Existing data was left untouched.</p>}
              {draftState === 'ready' && drafts.length === 0 && <p>No saved drafts yet. Your first save will be kept in your private workspace.</p>}
              {drafts.length > 0 && (
                <ul>
                  {drafts.map(saved => (
                    <li key={saved.id}>
                      <button type="button" onClick={() => openDraft(saved)} aria-label={`Open ${saved.name}`}>
                        <strong>{saved.name}</strong>
                        <small>{Math.round(saved.evolution.durationSeconds / 60)} min · {saved.evolution.character.replaceAll('-', ' ')}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {importErrors.length > 0 && (
              <div className="plab-import-errors" role="alert">
                <strong>Could not import recipe</strong>
                <ul>{importErrors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul>
              </div>
            )}
            {message && <p className="plab-save-status" data-testid="pattern-lab-save-status" aria-live="polite">{message}</p>}

            {draft && compatibility && (
              <div className="plab-use-in-project-promoted" data-testid="pattern-lab-use-in-project-promoted">
                <button
                  type="button"
                  className="btn primary"
                  disabled={compatibility.classification === 'studio-only'}
                  onClick={() => void useInProjectPrimary()}
                >{promotedActionLabel(compatibility)}</button>
                <span
                  className="plab-compat-badge"
                  data-testid="pattern-lab-compat-badge"
                  data-classification={compatibility.classification}
                >{compatibilityBadge(compatibility)}</span>
                <small className="plab-compat-hint">{promotedActionHint(compatibility)}</small>
              </div>
            )}

            </div>

            <div className="plab-actions">
              <button id="plab-save-private" type="button" className="btn primary" disabled={!draft} onClick={saveDraft}>Save private draft</button>
              <button type="button" className="btn" disabled={!draft} onClick={exportRecipe}>Export recipe</button>
              <button type="button" className="btn" onClick={() => importRef.current?.click()}>Import recipe</button>
              <input ref={importRef} className="plab-file-input" aria-label="Import recipe" aria-hidden="true" tabIndex={-1} type="file" accept=".lwrecipe.json,application/json" onChange={importRecipe} />
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
