import { useEffect, useMemo, useRef, useState } from 'react';
import { downloadJsonFile } from '../lib/downloadFile.js';
import { PATTERN_LAB_BLEND_MODES } from '../lib/patternLabCompositor.js';
import {
  classifyPatternLabCompatibility,
  createPatternLabDiagnosticsSnapshot,
  createPatternLabSimplificationVariant,
} from '../lib/patternLabCompatibility.js';
import { PATTERN_LAB_EVOLUTION_CHARACTERS, sampleEvolution } from '../lib/patternLabEvolution.js';
import { PATTERN_LAB_GENERATOR_IDS } from '../lib/patternLabGenerators.js';
import { resolvePatternLabMacros } from '../lib/patternLabMacros.js';
import { recipeFromPattern } from '../lib/patternLabPatternAdapter.js';
import { normalizePatternLabRecipe } from '../lib/patternLabRecipe.js';
import { readPatternLabDraftState, savePatternLabDraft } from '../lib/patternLabStorage.js';
import { PATTERN_LAB_WORKER_BUDGETS } from '../lib/patternLabWorkerProtocol.js';
import { isBuiltInPattern, listBuiltInPatterns } from '../lib/patternRegistry.js';
import { useProject } from '../state/ProjectContext.jsx';
import PatternLabControls from './PatternLabControls.jsx';
import PatternLabDiagnostics from './PatternLabDiagnostics.jsx';
import PatternLabEvolution from './PatternLabEvolution.jsx';
import PatternLabExport from './PatternLabExport.jsx';
import PatternLabLayers from './PatternLabLayers.jsx';
import PatternLabPreview from './PatternLabPreview.jsx';
import PatternLabVariants from './PatternLabVariants.jsx';
import './pattern-lab.css';

const WORKFLOW = [
  ['01', 'Choose', 'Begin with a built-in pattern.'],
  ['02', 'Sculpt', 'Shape it with five creative controls.'],
  ['03', 'Evolve', 'Build a five-to-fifteen-minute journey.'],
  ['04', 'Save', 'Keep a private, repeatable variation.'],
];
const COMPATIBILITY_OUTCOMES = [
  ['live-on-card', 'Live on card'],
  ['bake-to-card', 'Bake to card'],
  ['simplify-for-card', 'Simplify for card'],
  ['studio-only', 'Studio only'],
];
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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function previewMasterBrightness(recipe, previewTime) {
  const macroBrightness = resolvePatternLabMacros(recipe).energy.brightness;
  const evolution = recipe?.evolution?.enabled ? sampleEvolution(recipe, previewTime) : null;
  const amount = evolution?.change ?? 0;
  const destination = Math.min(
    macroBrightness,
    evolution?.destinations?.brightness ?? macroBrightness,
  );
  return clamp(macroBrightness + (destination - macroBrightness) * amount, 0.08, 1);
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
  const source = recipeFromPattern(stateful ? 'aurora' : recipe.base.patternId, { palette: recipe.palette });
  return withEvolutionDisabled({
    ...source,
    id: recipe.id,
    name: recipe.name,
    ...(stateful ? { base: cloneRecipe(recipe.base) } : {}),
  });
}

function deriveSeed(seed, index) {
  let value = ((Number(seed) >>> 0) + Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
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
  if (Number(value.version) !== 1) add('$.version', 'must be 1');
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
  const patterns = useMemo(() => listBuiltInPatterns(), []);
  const importRef = useRef(null);
  const drawerRef = useRef(null);
  const previewStageRef = useRef(null);
  const drawerTriggerRef = useRef(null);
  const drawerCloseRef = useRef(null);
  const [sourceRecipe, setSourceRecipe] = useState(null);
  const [draft, setDraft] = useState(null);
  const [comparison, setComparison] = useState('draft');
  const [previewTime, setPreviewTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [drafts, setDrafts] = useState([]);
  const [draftState, setDraftState] = useState('loading');
  const [message, setMessage] = useState('');
  const [importErrors, setImportErrors] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [variationRound, setVariationRound] = useState(0);
  const [seedLocked, setSeedLocked] = useState(false);
  const [previewFrameSignals, setPreviewFrameSignals] = useState({
    recipeId: null,
    frameObserved: false,
    sampledPixelCount: null,
    blackPixelCount: null,
  });
  const mobileDrawer = useMobileDrawer();
  const previewRecipe = comparison === 'source' ? sourceRecipe : draft;
  const previewDuration = draft?.evolution?.durationSeconds ?? 600;

  useEffect(() => {
    const state = readPatternLabDraftState();
    setDrafts(state.drafts);
    setDraftState(state.status === 'empty' || state.status === 'restored' ? 'ready' : state.status);
  }, []);

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
    drawerCloseRef.current?.focus();
    const closeOnEscape = event => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen, mobileDrawer]);

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

  const variantSeeds = useMemo(
    () => Array.from({ length: 4 }, (_, index) => deriveSeed(sourceRecipe?.seed ?? 1, index + variationRound * 4)),
    [sourceRecipe?.seed, variationRound],
  );
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

  function choosePattern(patternId) {
    if (!patternId) {
      setSourceRecipe(null);
      setDraft(null);
      return;
    }
    const generatorId = patternId.startsWith('generator:') ? patternId.slice('generator:'.length) : '';
    const stateful = PATTERN_LAB_GENERATOR_IDS.includes(generatorId);
    const source = stateful
      ? withEvolutionDisabled({
          ...recipeFromPattern('aurora', { palette: project.palette }),
          name: GENERATOR_NAMES[generatorId],
          base: { kind: generatorId, patternId: 'aurora', params: { advanced: {} } },
        })
      : withEvolutionDisabled(recipeFromPattern(patternId, { palette: project.palette }));
    setSourceRecipe(source);
    setDraft(cloneRecipe(source));
    setComparison('draft');
    setPreviewTime(0);
    setPlaying(false);
    setMessage('');
    setImportErrors([]);
    setVariationRound(0);
    setSeedLocked(false);
  }

  function changeMacro(name, value) {
    setDraft(current => current ? { ...current, macros: { ...current.macros, [name]: value } } : current);
    setComparison('draft');
    setMessage('');
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
    setComparison('draft');
    setMessage('');
  }

  function changeEvolution(name, value) {
    setDraft(current => current ? { ...current, evolution: { ...current.evolution, [name]: value } } : current);
    if (name === 'durationSeconds') setPreviewTime(current => Math.min(current, value));
    setComparison('draft');
    setMessage('');
  }

  function chooseSeed(seed) {
    setDraft(current => current ? {
      ...cloneRecipe(current),
      seed,
      evolution: { ...current.evolution, enabled: true },
    } : current);
    setComparison('draft');
    setMessage('');
  }

  function createNewVariations() {
    if (!seedLocked) setVariationRound(round => round + 1);
  }

  function closeDrawer() {
    setDrawerOpen(false);
    requestAnimationFrame(() => drawerTriggerRef.current?.focus());
  }

  function trapDrawerFocus(event) {
    if (!mobileDrawer || !drawerOpen || event.key !== 'Tab') return;
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

  function changeLayers(layers) {
    setDraft(current => current ? { ...current, layers: cloneRecipe(layers) } : current);
    setComparison('draft');
    setMessage('');
  }

  function addLayer() {
    setDraft(current => {
      if (!current || current.layers.length >= 3) return current;
      const index = current.layers.length + 1;
      return {
        ...current,
        layers: [...current.layers, {
          id: `layer-${current.id}-${index}`,
          name: `Layer ${index}`,
          blendMode: 'normal',
          opacity: 0.65,
        }],
      };
    });
    setComparison('draft');
  }

  function useDraftVariant(variant, status) {
    if (!variant) return;
    const next = normalizePatternLabRecipe(cloneRecipe(variant));
    setDraft(next);
    setComparison('draft');
    setPreviewTime(0);
    setPlaying(false);
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
    setComparison('draft');
    setPreviewTime(0);
    setPlaying(false);
    setMessage(`Opened ${normalized.name}`);
    setImportErrors([]);
    setVariationRound(0);
    setSeedLocked(false);
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save this private draft.');
    }
  }

  async function exportRecipe() {
    if (!draft) return;
    const canonical = normalizePatternLabRecipe(draft);
    await downloadJsonFile(safeFilename(canonical.name), canonical, { preferPicker: false });
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
      setComparison('draft');
      setPreviewTime(0);
      setImportErrors([]);
      setMessage(`Imported ${normalized.name}. Save when you want to keep it privately.`);
      setVariationRound(0);
      setSeedLocked(false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The file is not a valid Pattern Lab recipe.';
      setImportErrors([detail].slice(0, 4));
      setMessage('');
    }
  }

  return (
    <main className="screen plab-screen" data-testid="pattern-lab-screen">
      <div className="plab-scroll">
        <header className="plab-header" inert={mobileDrawer && drawerOpen ? '' : undefined}>
          <div>
            <span className="plab-kicker">Separate creative workspace</span>
            <h1>Pattern Lab</h1>
            <p>Turn familiar looks into detailed five-to-fifteen-minute light journeys. Nothing here changes your project or connected card.</p>
          </div>
          <div className="plab-isolation" role="status">
            <span className="plab-isolation-mark" aria-hidden="true" />
            <span><strong>Private workspace</strong>Your active project and connected lights stay unchanged.</span>
          </div>
        </header>

        <ol className="plab-workflow" aria-label="Pattern Lab workflow" inert={mobileDrawer && drawerOpen ? '' : undefined}>
          {WORKFLOW.map(([number, title, description], index) => (
            <li key={title} className={index === 0 ? 'current' : ''} aria-current={index === 0 ? 'step' : undefined}>
              <span className="plab-step-number">{number}</span>
              <span><strong>{title}</strong><small>{description}</small></span>
            </li>
          ))}
        </ol>

        <section className="plab-workspace" aria-label="Pattern authoring workspace">
          <div className="plab-preview" inert={mobileDrawer && drawerOpen ? '' : undefined}>
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
                  onClick={() => setDrawerOpen(open => !open)}
                >Controls</button>
              </div>
            </div>
            <div className="plab-stage" ref={previewStageRef}>
              {previewRecipe ? (
                <PatternLabPreview
                  recipe={previewRecipe}
                  previewTime={previewTime}
                  playing={playing}
                  geometry={geometry}
                  fallbackLook={project.standaloneController?.defaultLook}
                />
              ) : (
                <>
                  <SculpturePlaceholder />
                  <div className="plab-empty">
                    <span className="plab-empty-rule" aria-hidden="true" />
                    <h2>Begin with a pattern</h2>
                    <p>Choose a built-in look in the inspector. Pattern Lab makes a private copy you can stretch into a longer, less repetitive experience.</p>
                    <button type="button" className="btn primary" onClick={() => {
                      if (mobileDrawer) setDrawerOpen(true);
                      requestAnimationFrame(() => document.getElementById('plab-base-pattern')?.focus());
                    }}>Choose pattern</button>
                  </div>
                </>
              )}
            </div>
          </div>

          {mobileDrawer && drawerOpen && (
            <button className="plab-drawer-backdrop" type="button" aria-label="Dismiss pattern controls" onClick={closeDrawer} />
          )}
          <aside
            ref={drawerRef}
            id="plab-controls-drawer"
            className={`plab-controls${drawerOpen ? ' drawer-open' : ''}`}
            aria-label="Pattern Lab controls"
            role={mobileDrawer ? 'dialog' : undefined}
            aria-modal={mobileDrawer && drawerOpen ? 'true' : undefined}
            aria-hidden={mobileDrawer && !drawerOpen ? 'true' : undefined}
            inert={mobileDrawer && !drawerOpen ? '' : undefined}
            onKeyDown={trapDrawerFocus}
          >
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
            <div id="plab-pattern-select">
              <PatternLabControls
                patterns={patterns}
                recipe={draft}
                selectedPatternId={PATTERN_LAB_GENERATOR_IDS.includes(draft?.base?.kind)
                  ? `generator:${draft.base.kind}`
                  : draft?.base?.patternId || ''}
                onPatternChange={choosePattern}
                onMacroChange={changeMacro}
                onAdvancedChange={changeAdvanced}
              />
            </div>
            <PatternLabEvolution
              recipe={draft}
              previewTime={previewTime}
              onEvolutionChange={changeEvolution}
              onPreviewTime={setPreviewTime}
            />
            <PatternLabVariants
              recipe={draft}
              sourceSeed={sourceRecipe?.seed}
              variantSeeds={variantSeeds}
              geometry={geometry}
              previewTime={previewTime}
              renderPreviews={!mobileDrawer || drawerOpen}
              comparison={comparison}
              seedLocked={seedLocked}
              onComparison={setComparison}
              onSelectSeed={chooseSeed}
              onSeedLock={setSeedLocked}
              onNewVariations={createNewVariations}
            />
            {draft && (
              <div className="plab-layer-inspector">
                <PatternLabLayers
                  layers={draft.layers}
                  onAddLayer={addLayer}
                  onLayersChange={changeLayers}
                />
              </div>
            )}

            {draft && (
              <details
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
                    onBake={() => setMessage('Baked card export is not enabled in this preview-only workspace.')}
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

            <section className="plab-private-library" aria-labelledby="plab-private-heading">
              <div className="plab-library-heading">
                <div><span className="plab-section-index">Saved</span><h2 id="plab-private-heading">Private drafts</h2></div>
                <span>{drafts.length}</span>
              </div>
              {draftState === 'loading' && <p>Loading private drafts…</p>}
              {draftState === 'unavailable' && <p role="alert">Private draft storage is unavailable in this browser.</p>}
              {draftState === 'unrecoverable' && <p role="alert">Private drafts could not be recovered. Existing data was left untouched.</p>}
              {draftState === 'ready' && drafts.length === 0 && <p>No saved drafts yet. Your first save stays only in this browser.</p>}
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

            <div className="plab-actions">
              <button type="button" className="btn primary" disabled={!draft} onClick={saveDraft}>Save private draft</button>
              <button type="button" className="btn" disabled={!draft} onClick={exportRecipe}>Export recipe</button>
              <button type="button" className="btn" onClick={() => importRef.current?.click()}>Import recipe</button>
              <input ref={importRef} className="plab-file-input" aria-label="Import recipe" type="file" accept=".lwrecipe.json,application/json" onChange={importRecipe} />
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
