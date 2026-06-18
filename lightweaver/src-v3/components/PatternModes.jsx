import { useState, useEffect, useRef, useMemo } from 'react';
import { PATTERNS, DEFAULT_PARAMS, PATTERN_CODE } from '../data.js';
import { curvedRangeValueToSlider, sliderValueToCurvedRange } from '../lib/controlScale.js';
import { PATTERNS as LIB_PATTERNS } from '../lib/patterns-library.js';
import { compile } from '../lib/patterns.js';
import { makePatternStudioSummary } from '../lib/patternStudio.js';
import { stripOverrideIdsToClearForGlobalSelection } from '../lib/patternTargeting.js';
import {
  CUSTOM_PATTERNS_EVENT,
  deleteCustomPattern,
  loadCustomPatterns,
  saveCustomPattern,
} from '../lib/customPatterns.js';
import { getPatternById, getPatternCode } from '../lib/patternRegistry.js';
import { parseParamsFromCode } from '../lib/patternParams.js';
import { useProject } from '../state/ProjectContext.jsx';
import {
  WLED_ENCODER_ROTATE_DIRECTIONS,
  normalizeWledPhysicalControls,
} from '../lib/wledControlContract.js';
import {
  insertPatternInCycle,
  makeDefaultRotaryCycleIds,
  normalizeRotaryPatternCycle,
} from '../lib/rotaryPatternCycle.js';

// ── Pattern category system ─────────────────────────────────────────────────
const CATEGORY_RULES = {
  audio:    ids => ids.filter(id => {
    const p = LIB_PATTERNS.find(p => p.id === id);
    return p?.code && (p.code.includes('bass') || p.code.includes('mid') || p.code.includes(' hi'));
  }),
  fire:     ['fire', 'lava', 'ember', 'candle', 'solar', 'nova', 'sunrise', 'sunrise-v2', 'thermal', 'lava-flow', 'particle-burst', 'thermal-cam', 'sand-dune', 'sunrise-horizon', 'lightning-storm'],
  water:    ['ocean', 'ripple', 'wave', 'tide', 'waterfall', 'fluid', 'bubble', 'smoke', 'smoke-haze', 'oil-slick', 'deep-sea', 'snow-globe', 'interference', 'bubble-wrap', 'watercolor-wash'],
  space:    ['aurora', 'galaxy', 'comet', 'meteor', 'hyperspace', 'sparkle', 'twinkle', 'starfield', 'northern', 'fractal', 'jellyfish', 'constellation', 'tesseract', 'zodiac', 'aurora-borealis', 'wormhole', 'bioluminescence', 'meteor-shower', 'aurora-curtain', 'plasma-ball', 'prism-split', 'mirror-tunnel', 'fiber-optic'],
  geo:      ['plasma', 'mandala', 'vortex', 'lissajous', 'prism', 'dna', 'circuit', 'blocks', 'warp', 'pulse-ring', 'binary-pulse', 'kaleido', 'pixelate', 'mandelbrot', 'pendulum', 'soundwave', 'circuit-board', 'prismatic', 'crystallize', 'hypnotic-spiral', 'breathing-grid', 'kaleidoscope-v2', 'tie-dye', 'voronoi', 'interference', 'mirror-warp', 'lissajous-v2', 'neon-grid', 'mirror-tunnel'],
  chill:    ['breathe', 'calm', 'drift', 'zen', 'bloom', 'fade', 'gradient', 'tide', 'watercolor', 'northern', 'ribbons', 'lotus', 'iceberg', 'lava-lamp', 'bioluminescence', 'breathing-grid', 'sand-dune', 'snow-globe', 'watercolor-wash', 'oil-painting', 'sunrise-horizon'],
  glitch:   ['glitch', 'strobe', 'matrix', 'neon', 'heartbeat', 'inkdrop', 'stained', 'scanner', 'morse', 'strobe-bpm', 'kick-flash', 'beat-grid', 'pulse-expand', 'confetti-bpm', 'digitrain', 'cityscape', 'pixel-rain', 'digital-rain-v2', 'strobe-color', 'neon-sign', 'retro-scan', 'paint-drip', 'pixel-sort', 'lightning-storm'],
};

function getCategory(patternId) {
  for (const [cat, rule] of Object.entries(CATEGORY_RULES)) {
    if (typeof rule === 'function') {
      // skip function-based categories for static lookup
    } else if (rule.includes(patternId)) return cat;
  }
  return null;
}

// ── CARDS mode ─────────────────────────────────────────────────────────────
const LS_FAV_KEY     = 'lw_fav_patterns';
const LS_PRESETS_KEY = 'lw_param_presets';
const LS_RECENT_KEY  = 'lw_recent_patterns';

function loadFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(LS_FAV_KEY) || '[]')); } catch { return new Set(); }
}

function loadPresets() {
  try { return JSON.parse(localStorage.getItem(LS_PRESETS_KEY) || '{}'); } catch { return {}; }
}

function savePresets(presets) {
  try { localStorage.setItem(LS_PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

const CATS = ['all', 'recent', 'custom', 'audio', 'fire', 'water', 'space', 'geo', 'chill', 'glitch'];

const DEFAULT_PATTERN_JOURNEY = {
  enabled: false,
  duration: 24,
  loop: 'repeat',
  easing: 'smooth',
  colorMix: 0.65,
  colorStops: ['#ffd000', '#ff7a18', '#fff5d6'],
  saturationStart: 1,
  saturationEnd: 0.35,
  speedStart: 0.45,
  speedEnd: 1.8,
};

function normalizeHexColor(value, fallback = '#ffffff') {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return fallback;
}

function getPatternJourney(params = {}) {
  const savedStops = Array.isArray(params.__journey?.colorStops) && params.__journey.colorStops.length
    ? params.__journey.colorStops
    : DEFAULT_PATTERN_JOURNEY.colorStops;
  const colorStops = savedStops.map((hex, index) => (
    normalizeHexColor(hex, DEFAULT_PATTERN_JOURNEY.colorStops[index % DEFAULT_PATTERN_JOURNEY.colorStops.length])
  ));
  while (colorStops.length < 2) {
    colorStops.push(DEFAULT_PATTERN_JOURNEY.colorStops[colorStops.length] || '#ffffff');
  }

  return {
    ...DEFAULT_PATTERN_JOURNEY,
    ...(params.__journey || {}),
    colorStops,
  };
}

function BuilderSlider({ label, value, min, max, step = 0.01, onChange, readout }) {
  return (
    <label className="lw-builder-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
      />
      <strong>{readout}</strong>
    </label>
  );
}

function PaletteEditor({ palette, selectedIndex, setSelectedIndex, onPaletteChange }) {
  const safePalette = palette?.length ? palette : ['#ff6b6b', '#ffd166', '#06d6a0'];
  const selectedHex = normalizeHexColor(safePalette[selectedIndex] || safePalette[0]);
  const [hexDraft, setHexDraft] = useState(selectedHex);
  useEffect(() => setHexDraft(selectedHex), [selectedHex]);
  const updateSelected = (value) => {
    const nextHex = normalizeHexColor(value, selectedHex);
    const next = [...safePalette];
    next[selectedIndex] = nextHex;
    onPaletteChange(next);
  };

  return (
    <div className="lw-builder-block lw-palette-editor">
      <div className="lw-builder-block-head">
        <strong>Palette editor</strong>
        <span>live preview</span>
      </div>
      <div className="lw-color-swatch-row" aria-label="Palette colors">
        {safePalette.map((hex, index) => (
          <button
            key={`${hex}-${index}`}
            type="button"
            className="lw-color-swatch"
            style={{ background: normalizeHexColor(hex) }}
            aria-label={`Palette color ${index + 1}`}
            aria-pressed={selectedIndex === index}
            draggable
            onDragStart={event => {
              const color = normalizeHexColor(hex);
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('application/x-lightweaver-color', color);
              event.dataTransfer.setData('text/plain', color);
            }}
            onClick={() => setSelectedIndex(index)}
          />
        ))}
      </div>
      <div className="lw-color-picker-row">
        <input
          aria-label="Selected palette color"
          type="color"
          value={selectedHex}
          onChange={event => updateSelected(event.target.value)}
        />
        <input
          aria-label="Selected palette hex"
          type="text"
          value={hexDraft}
          onChange={event => {
            const next = event.target.value;
            setHexDraft(next);
            if (/^#[0-9a-f]{6}$/i.test(next)) updateSelected(next);
          }}
          onBlur={() => setHexDraft(selectedHex)}
        />
      </div>
    </div>
  );
}

const PARAM_META = {
  speed: { label: 'Speed', group: 'Motion', desc: 'How fast the animation moves.', unit: 'x' },
  rate: { label: 'Rate', group: 'Motion', desc: 'Pulse or flicker frequency.', unit: 'x' },
  rise: { label: 'Upward drift', group: 'Motion', desc: 'How quickly the motion travels upward.', unit: 'x' },
  wind: { label: 'Wind', group: 'Motion', desc: 'Horizontal drift and turbulence.', unit: 'x' },
  drift: { label: 'Drift', group: 'Motion', desc: 'Slow movement through the pattern.', unit: 'x' },
  spin: { label: 'Spin', group: 'Motion', desc: 'Rotation speed around the center.', unit: 'x' },
  hueSpeed: { label: 'Hue speed', group: 'Motion', desc: 'How quickly the color cycles.', unit: 'x' },
  freq: { label: 'Wave count', group: 'Shape', desc: 'Number of waves across the artwork.' },
  freqX: { label: 'Horizontal waves', group: 'Shape', desc: 'Wave count across X.' },
  freqY: { label: 'Vertical waves', group: 'Shape', desc: 'Wave count across Y.' },
  scale: { label: 'Texture scale', group: 'Shape', desc: 'Size of the noise or texture detail.' },
  width: { label: 'Width', group: 'Shape', desc: 'Thickness of the visible band or beam.' },
  thick: { label: 'Line thickness', group: 'Shape', desc: 'Thickness of the drawn light line.' },
  dotSize: { label: 'Dot size', group: 'Shape', desc: 'Size of the moving point.' },
  tailLen: { label: 'Tail length', group: 'Shape', desc: 'Length of the fading trail.' },
  ringWidth: { label: 'Ring width', group: 'Shape', desc: 'Thickness of each pulse ring.' },
  rings: { label: 'Rings', group: 'Shape', desc: 'Number of visible rings.' },
  arms: { label: 'Arms', group: 'Shape', desc: 'Number of spiral arms.' },
  petals: { label: 'Petals', group: 'Shape', desc: 'Number of repeated petal shapes.' },
  layers: { label: 'Layers', group: 'Shape', desc: 'Number of overlapping shape layers.' },
  facets: { label: 'Facets', group: 'Shape', desc: 'Number of crystal-like angular sections.' },
  count: { label: 'Count', group: 'Shape', desc: 'Number or amount of repeated elements.' },
  cols: { label: 'Columns', group: 'Shape', desc: 'Number of vertical columns.' },
  rows: { label: 'Rows', group: 'Shape', desc: 'Number of horizontal rows.' },
  size: { label: 'Size', group: 'Shape', desc: 'Overall element size.' },
  zoom: { label: 'Zoom', group: 'Shape', desc: 'Pattern magnification.' },
  twist: { label: 'Twist', group: 'Shape', desc: 'How strongly the geometry bends or spirals.' },
  warp: { label: 'Warp', group: 'Shape', desc: 'Amount of spatial distortion.' },
  spread: { label: 'Spread', group: 'Shape', desc: 'How far the light separates or expands.' },
  angle: { label: 'Angle', group: 'Shape', desc: 'Direction of the effect.', unit: 'turn' },
  density: { label: 'Density', group: 'Intensity', desc: 'How many particles, sparks, or details appear.' },
  chaos: { label: 'Randomness', group: 'Intensity', desc: 'How unpredictable the effect becomes.' },
  flicker: { label: 'Flicker', group: 'Intensity', desc: 'Amount or speed of unstable flicker.' },
  duty: { label: 'Flash length', group: 'Intensity', desc: 'How long the light stays on during each pulse.' },
  glow: { label: 'Glow', group: 'Intensity', desc: 'Soft halo or bloom strength.' },
  intensity: { label: 'Intensity', group: 'Intensity', desc: 'Overall force of the effect.' },
  hue: { label: 'Hue', group: 'Color', desc: 'Base color around the color wheel.', unit: 'hue' },
  saturation: { label: 'Saturation', group: 'Color', desc: 'Color purity.' },
  contrast: { label: 'Contrast', group: 'Color', desc: 'Difference between dark and bright areas.' },
  hour: { label: 'Sun position', group: 'Color', desc: 'Position through the sunrise/sunset gradient.' },
  bands: { label: 'Color bands', group: 'Color', desc: 'Number of distinct color bands.' },
  creatures: { label: 'Creatures', group: 'Shape', desc: 'Number of moving organic forms.' },
  dunes: { label: 'Dunes', group: 'Shape', desc: 'Number of dune ridges.' },
};

const PARAM_GROUP_ORDER = ['Motion', 'Shape', 'Color', 'Intensity', 'Audio', 'Advanced'];
const PARAM_SLIDER_STEPS = 1000;
const ROTARY_PATTERN_DRAG_MIME = 'application/x-lightweaver-pattern-id';

function titleizeParam(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function getParamMeta(param) {
  return PARAM_META[param.name] || {
    label: titleizeParam(param.name),
    group: ['bass', 'mid', 'hi', 'audio'].some(k => param.name.toLowerCase().includes(k)) ? 'Audio' : 'Advanced',
    desc: 'Effect-specific control.',
  };
}

function formatParamValue(value, param, meta) {
  if (meta.unit === 'hue') return `${Math.round(value * 360)}°`;
  if (meta.unit === 'turn') return `${Math.round(value * 360)}°`;
  if (meta.unit === 'x') {
    if (value < 0.1) return `${value.toFixed(3).replace(/0$/, '')}×`;
    if (value < 1) return `${value.toFixed(2)}×`;
    return `${value.toFixed(param.step < 0.05 ? 2 : 1)}×`;
  }
  if (param.max <= 1 && param.min >= 0) return `${Math.round(value * 100)}%`;
  return value.toFixed(param.step < 0.05 ? 3 : param.step < 0.5 ? 2 : 1);
}

function usesCurvedParamScale(param, meta) {
  return meta.unit === 'x' && Number(param.max) > Number(param.min);
}

function paramToSliderValue(value, param, meta) {
  if (!usesCurvedParamScale(param, meta)) return value;
  return curvedRangeValueToSlider(value, { min: param.min, max: param.max, steps: PARAM_SLIDER_STEPS });
}

function sliderToParamValue(value, param, meta) {
  if (!usesCurvedParamScale(param, meta)) return +value;
  return sliderValueToCurvedRange(value, {
    min: param.min,
    max: param.max,
    steps: PARAM_SLIDER_STEPS,
    precision: param.step < 0.05 ? 3 : 2,
  });
}

function patternUsesPalette(patternId) {
  const code = PATTERN_CODE[patternId] || getPatternCode(patternId) || LIB_PATTERNS.find(p => p.id === patternId)?.code || '';
  return /\bsamplePalette\s*\(|\bpalette\b/.test(code);
}

export function CardsMode({
  patternId,
  onSelectPattern,
  params,
  onParamChange,
  patternParams = {},
  onPatternParamsChange = null,
  palette,
  onPaletteChange,
  strips = [],
  onAssignStripPattern = null,
}) {
  const { physicalControls, setPhysicalControls, showClips } = useProject();
  const [search, setSearch]     = useState('');
  const [showFavs, setShowFavs] = useState(false);
  const [cat, setCat]           = useState('all');
  const [effectTarget, setEffectTarget] = useState('global');
  const [showFullLibrary, setShowFullLibrary] = useState(false);
  const [favs, setFavsState]    = useState(loadFavs);
  const [presets, setPresetsState] = useState(loadPresets);
  const [customPatterns, setCustomPatterns] = useState(loadCustomPatterns);
  const [rotaryOpen, setRotaryOpen] = useState(false);
  const [rotaryDragOverIndex, setRotaryDragOverIndex] = useState(null);
  const [inspectorDragActive, setInspectorDragActive] = useState(false);
  const [recentIds, setRecentIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_RECENT_KEY) || '[]'); } catch { return []; }
  });

  useEffect(() => {
    const handler = () => setCustomPatterns(loadCustomPatterns());
    window.addEventListener(CUSTOM_PATTERNS_EVENT, handler);
    return () => window.removeEventListener(CUSTOM_PATTERNS_EVENT, handler);
  }, []);

  const allPatterns = useMemo(() => [...customPatterns, ...PATTERNS], [customPatterns]);

  const savePreset = () => {
    const name = prompt('Preset name:');
    if (!name?.trim()) return;
    const next = { ...presets, [`${tuningPatternId}/${name.trim()}`]: { ...tuningParams } };
    setPresetsState(next);
    savePresets(next);
  };

  const loadPreset = (key) => {
    const p = presets[key];
    if (!p) return;
    Object.entries(p).forEach(([k, v]) => handleParamChange(k, v));
  };

  const deletePreset = (key, e) => {
    e.stopPropagation();
    const next = { ...presets };
    delete next[key];
    setPresetsState(next);
    savePresets(next);
  };

  const setFavs = (updater) => {
    setFavsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      localStorage.setItem(LS_FAV_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const toggleFav = (id, e) => {
    e.stopPropagation();
    setFavs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const globalPattern = getPatternById(patternId) || PATTERNS.find(p => p.id === patternId);

  const audioIds = useMemo(() =>
    new Set(LIB_PATTERNS.filter(p => p.code && (p.code.includes('bass') || p.code.includes(' mid') || p.code.includes(' hi'))).map(p => p.id)),
    []
  );

  const handleSelectPattern = (id) => {
    if (effectTarget === 'global') {
      onSelectPattern(id);
      stripOverrideIdsToClearForGlobalSelection(strips).forEach(stripId => {
        onAssignStripPattern?.(stripId, null);
      });
    } else {
      onAssignStripPattern?.(effectTarget, id);
    }
    setRecentIds(prev => {
      const next = [id, ...prev.filter(r => r !== id)].slice(0, 12);
      localStorage.setItem(LS_RECENT_KEY, JSON.stringify(next));
      return next;
    });
  };

  const clearStripPattern = (stripId) => {
    onAssignStripPattern?.(stripId, null);
  };

  const selectedTargetStrip = strips.find(s => s.id === effectTarget);
  const singleStripGlobalMask = effectTarget === 'global'
    ? strips.find(strip => stripOverrideIdsToClearForGlobalSelection(strips).includes(strip.id))
    : null;
  const activeTargetPatternId = effectTarget === 'global'
    ? patternId
    : selectedTargetStrip?.patternId || patternId;
  const tuningPatternId = activeTargetPatternId;
  const tuningPattern = getPatternById(tuningPatternId) || allPatterns.find(p => p.id === tuningPatternId);
  const tuningParams = patternParams?.[tuningPatternId] || (tuningPatternId === patternId ? params : {});
  const paletteIsUsed = patternUsesPalette(tuningPatternId);

  // Merge static DEFAULT_PARAMS with @param annotations from library code.
  const activeLibPattern = getPatternById(tuningPatternId) || LIB_PATTERNS.find(p => p.id === tuningPatternId);
  const libKnobs  = activeLibPattern?.code ? parseParamsFromCode(activeLibPattern.code) : [];
  const knobs     = (DEFAULT_PARAMS[tuningPatternId] || []).length > 0
                      ? DEFAULT_PARAMS[tuningPatternId] || []
                      : libKnobs;
  const groupedKnobs = PARAM_GROUP_ORDER.map(group => ({
    group,
    knobs: knobs.filter(k => getParamMeta(k).group === group),
  })).filter(entry => entry.knobs.length > 0);
  const myPresets = Object.keys(presets).filter(k => k.startsWith(`${tuningPatternId}/`));
  const studioSummary = useMemo(() => makePatternStudioSummary(activeLibPattern || tuningPattern || {}, {
    params: tuningParams,
    palette,
    targetRuntime: 'wled-basic',
  }), [activeLibPattern, tuningPattern, tuningParams, palette]);
  const rotaryControls = useMemo(
    () => normalizeWledPhysicalControls(physicalControls),
    [physicalControls],
  );
  const knownPatternIds = useMemo(() => new Set(allPatterns.map(pattern => pattern.id)), [allPatterns]);
  const storedCycleIds = normalizeRotaryPatternCycle(rotaryControls.encoder.patternCycleIds, knownPatternIds);
  const defaultCycleIds = useMemo(() => makeDefaultRotaryCycleIds({
    activePatternId: patternId,
    showClips: showClips || [],
    knownPatternIds,
  }), [patternId, showClips, knownPatternIds]);
  const visibleCycleIds = storedCycleIds.length ? storedCycleIds : defaultCycleIds;
  const rotaryCycleIsCustom = storedCycleIds.length > 0;
  const rotaryCycleNames = visibleCycleIds
    .map(id => allPatterns.find(pattern => pattern.id === id)?.name || id);
  const rotaryTurnLabel = rotaryControls.encoder.rotateDirection === WLED_ENCODER_ROTATE_DIRECTIONS.CLOCKWISE_DIMMER
    ? 'clockwise dims'
    : 'clockwise brightens';
  const rotaryCycleSummary = rotaryCycleNames.length
    ? rotaryCycleNames.slice(0, 3).join(' > ') + (rotaryCycleNames.length > 3 ? ` +${rotaryCycleNames.length - 3}` : '')
    : 'no push cycle';

  const updateRotaryControls = (patch) => {
    setPhysicalControls(prev => {
      const current = normalizeWledPhysicalControls(prev);
      const nextPatch = typeof patch === 'function' ? patch(current.encoder) : patch;
      return normalizeWledPhysicalControls({
        ...current,
        encoder: {
          ...current.encoder,
          ...nextPatch,
        },
      });
    });
  };

  const saveCycleIds = (cycleIds) => {
    updateRotaryControls({
      enabled: true,
      pressAction: 'next-preset',
      patternCycleIds: normalizeRotaryPatternCycle(cycleIds, knownPatternIds),
    });
  };

  const moveCycleId = (index, direction) => {
    const cycleId = visibleCycleIds[index];
    const target = index + direction;
    if (!cycleId || target < 0 || target >= visibleCycleIds.length) return;
    saveCycleIds(insertPatternInCycle(visibleCycleIds, cycleId, target, knownPatternIds));
  };

  const addCurrentToCycle = () => {
    saveCycleIds(insertPatternInCycle(visibleCycleIds, tuningPatternId, visibleCycleIds.length, knownPatternIds));
  };

  const removeCycleId = (index) => {
    saveCycleIds(visibleCycleIds.filter((_, itemIndex) => itemIndex !== index));
  };

  const startPatternDrag = (event, patternIdToDrag) => {
    if (!knownPatternIds.has(patternIdToDrag)) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(ROTARY_PATTERN_DRAG_MIME, patternIdToDrag);
    event.dataTransfer.setData('text/plain', patternIdToDrag);
    setRotaryOpen(true);
  };

  const readDraggedPatternId = (event) => (
    event.dataTransfer.getData(ROTARY_PATTERN_DRAG_MIME)
    || event.dataTransfer.getData('text/plain')
  );

  const handleRotaryDragOver = (event, targetIndex = visibleCycleIds.length) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setRotaryOpen(true);
    setRotaryDragOverIndex(targetIndex);
  };

  const handleRotaryDrop = (event, targetIndex = visibleCycleIds.length) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedPatternId = readDraggedPatternId(event);
    if (draggedPatternId) {
      saveCycleIds(insertPatternInCycle(visibleCycleIds, draggedPatternId, targetIndex, knownPatternIds));
    }
    setRotaryOpen(true);
    setRotaryDragOverIndex(null);
    setInspectorDragActive(false);
  };

  const handleInspectorDragOver = (event) => {
    if (!Array.from(event.dataTransfer.types || []).includes(ROTARY_PATTERN_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setRotaryOpen(true);
    setInspectorDragActive(true);
    setRotaryDragOverIndex(visibleCycleIds.length);
  };

  const handleInspectorDragLeave = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setInspectorDragActive(false);
    setRotaryDragOverIndex(null);
  };

  const handleInspectorDrop = (event) => {
    if (!Array.from(event.dataTransfer.types || []).includes(ROTARY_PATTERN_DRAG_MIME)) return;
    event.preventDefault();
    const draggedPatternId = readDraggedPatternId(event);
    if (draggedPatternId) {
      saveCycleIds(insertPatternInCycle(visibleCycleIds, draggedPatternId, visibleCycleIds.length, knownPatternIds));
    }
    setRotaryOpen(true);
    setInspectorDragActive(false);
    setRotaryDragOverIndex(null);
  };

  const handleParamChange = (name, value) => {
    if (onPatternParamsChange) {
      onPatternParamsChange(tuningPatternId, {
        ...tuningParams,
        [name]: value,
      });
    } else {
      onParamChange(name, value);
    }
  };

  const selectAdjacentPattern = (direction) => {
    const idx = allPatterns.findIndex(p => p.id === activeTargetPatternId);
    const baseIdx = idx >= 0 ? idx : allPatterns.findIndex(p => p.id === patternId);
    const next = allPatterns[(baseIdx + direction + allPatterns.length) % allPatterns.length];
    handleSelectPattern(next.id);
  };

  const filtered = useMemo(() => {
    if (cat === 'custom') {
      const q = search.trim().toLowerCase();
      return q ? customPatterns.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : customPatterns;
    }
    let base = showFavs ? allPatterns.filter(p => favs.has(p.id)) : PATTERNS;
    if (cat === 'recent') {
      base = recentIds.map(id => allPatterns.find(p => p.id === id)).filter(Boolean);
    } else if (cat === 'audio') {
      base = base.filter(p => audioIds.has(p.id));
    } else if (cat !== 'all') {
      const rule = CATEGORY_RULES[cat];
      if (Array.isArray(rule)) base = base.filter(p => rule.includes(p.id));
    }
    if (cat === 'all' && !showFavs && customPatterns.length > 0) base = [...customPatterns, ...base];
    const q = search.trim().toLowerCase();
    let result = q ? base.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      (p.desc && p.desc.toLowerCase().includes(q))
    ) : base;
    return result;
  }, [search, showFavs, favs, cat, audioIds, recentIds, customPatterns, allPatterns]);

  // Number keys 1-9 quick-select first 9 visible cards (must be after filtered + handleSelectPattern)
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const n = parseInt(e.key);
      if (!isNaN(n) && n >= 1 && n <= 9) {
        const p = filtered[n - 1];
        if (p) handleSelectPattern(p.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [filtered, handleSelectPattern]);

  const starterMode = !showFullLibrary && !search.trim() && !showFavs && cat === 'all';
  const visiblePatterns = starterMode ? filtered.slice(0, 12) : filtered;

  return (
    <div className="lw-cards-mode">
      <div className="lw-sec-header">
        <span>Effects</span>
        <span className="meta">{effectTarget === 'global' ? 'global' : selectedTargetStrip?.name || 'layer'} target</span>
      </div>
      {starterMode && (
        <div className="lw-browse-guide">
          <span>Start with one strong look, then tune color and motion.</span>
          <button type="button" className="btn btn-ghost" onClick={() => setShowFullLibrary(true)}>
            Show all patterns
          </button>
        </div>
      )}

      <div className="lw-effect-targets">
        <button
          className={`lw-effect-target ${effectTarget === 'global' ? 'active' : ''}`}
          onClick={() => setEffectTarget('global')}
          title="Apply clicked effects as the default effect for the whole piece">
          <span className="lw-effect-target-dot" style={{ background: 'var(--accent)' }}/>
          <span className="name">Global default</span>
          <span className="meta">{globalPattern?.name || patternId}</span>
        </button>
        {strips.map(strip => {
          const override = strip.patternId ? allPatterns.find(p => p.id === strip.patternId)?.name || strip.patternId : 'Inherited';
          return (
            <button
              key={strip.id}
              className={`lw-effect-target ${effectTarget === strip.id ? 'active' : ''}`}
              onClick={() => setEffectTarget(strip.id)}
              title="Select this layer as the target for clicked effects">
              <span className="lw-effect-target-dot" style={{ background: strip.color || 'var(--accent)' }}/>
              <span className="name">{strip.name}</span>
              <span className="meta">{override}</span>
              {strip.patternId && (
                <span
                  className="clear"
                  title="Clear layer effect override"
                  onClick={e => { e.stopPropagation(); clearStripPattern(strip.id); }}>
                  ×
                </span>
              )}
            </button>
          );
        })}
      </div>

      {effectTarget !== 'global' && (
        <div className="lw-effect-target-note">
          Clicking an effect applies it to <strong>{selectedTargetStrip?.name || 'selected layer'}</strong>. Clear the override to inherit Global.
        </div>
      )}
      {singleStripGlobalMask && (
        <div className="lw-effect-target-note">
          This single-strip piece has a layer override. Choosing a Global effect will put <strong>{singleStripGlobalMask.name || 'the strip'}</strong> back on Global.
        </div>
      )}

      <div className="lw-effect-workspace">
        <div className="lw-effect-browser">
      <div className="lw-effect-searchbar">
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            className="lw-search-input"
            aria-label="Search patterns"
            placeholder="Search patterns…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.target.blur(); } }}
          />
          {search && (
            <button onClick={() => setSearch('')}
                    style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
                             background: 'none', border: 'none', cursor: 'pointer',
                             color: 'var(--text-4)', fontSize: 'var(--fs-md)', lineHeight: 1, padding: '0 2px' }}>
              ×
            </button>
          )}
        </div>
        <button
          className={`btn btn-ghost ${showFavs ? 'active' : ''}`}
          style={{ fontSize: 'var(--fs-sm)', padding: '3px 7px', flexShrink: 0 }}
          title={showFavs ? 'Show all' : 'Show favorites'}
          onClick={() => setShowFavs(f => !f)}>
          ★
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 7px', flexShrink: 0 }}
          title="Previous pattern"
          onClick={() => selectAdjacentPattern(-1)}>
          ‹
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 7px', flexShrink: 0 }}
          title="Next pattern"
          onClick={() => selectAdjacentPattern(1)}>
          ›
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 'var(--fs-xs)', padding: '3px 7px', flexShrink: 0 }}
          title="Random pattern"
          onClick={() => {
            const pool = showFavs && favs.size > 0 ? allPatterns.filter(p => favs.has(p.id)) : allPatterns;
            const pick = pool[Math.floor(Math.random() * pool.length)];
            handleSelectPattern(pick.id);
          }}>
          ⟳
        </button>
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', paddingBottom: 8 }}>
        {CATS.map(c => (
          <button key={c}
                  className={`btn btn-ghost ${cat === c ? 'active' : ''}`}
                  style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px', borderRadius: 99, textTransform: 'capitalize' }}
                  onClick={() => setCat(c)}>
            {c === 'audio' ? '♪ audio' : c === 'geo' ? 'geometric' : c}
          </button>
        ))}
      </div>

      {search && filtered.length === 0 && (
        <div style={{ padding: '16px', color: 'var(--text-4)', fontSize: 'var(--fs-sm)', textAlign: 'center' }}>
          No patterns match "{search}"
        </div>
      )}

      <div className="lw-pattern-grid">
        {visiblePatterns.map((p, cardIdx) => (
          <div key={p.id}
               className={`lw-pattern-card ${p.id === activeTargetPatternId ? 'selected' : ''}`}
               draggable={knownPatternIds.has(p.id)}
               onDragStart={event => startPatternDrag(event, p.id)}
               onClick={() => handleSelectPattern(p.id)}
               title={p.desc || 'Drag into rotary push order'}>
            <div className="bg" style={{ background: p.preview }}/>
            <div className="scrim"/>
            <div className="label">
              <span>{p.name}</span>
              <span className="play-hint">
                <svg width="7" height="7" viewBox="0 0 7 7"><path d="M1 1 L6 3.5 L1 6 Z" fill="white"/></svg>
              </span>
            </div>
            {p.custom && (
              <div style={{ position: 'absolute', top: 3, left: 3, fontSize: 'var(--fs-2xs)', background: 'oklch(78% 0.14 300/0.85)',
                            color: 'var(--bg)', borderRadius: 2, padding: '1px 3px', fontWeight: 600 }}>
                ✏ CUSTOM
              </div>
            )}
            {!p.custom && p.code && (p.code.includes('bass') || p.code.includes('mid') || p.code.includes('hi')) && (
              <div style={{ position: 'absolute', top: 3, left: 3, fontSize: 'var(--fs-2xs)', background: 'oklch(74% 0.13 210/0.8)',
                            color: 'var(--bg)', borderRadius: 2, padding: '1px 3px', fontWeight: 600 }}>
                AUDIO
              </div>
            )}
            {!p.custom && patternUsesPalette(p.id) && (
              <div style={{ position: 'absolute', top: 3, left: (p.code && (p.code.includes('bass') || p.code.includes('mid') || p.code.includes('hi'))) ? 38 : 3,
                            fontSize: 'var(--fs-2xs)', background: 'oklch(78% 0.11 80/0.86)',
                            color: 'var(--bg)', borderRadius: 2, padding: '1px 3px', fontWeight: 600 }}>
                PAL
              </div>
            )}
            {!p.custom && cardIdx < 9 && (
              <div style={{ position: 'absolute', bottom: 3, right: 3, fontSize: 'var(--fs-2xs)',
                            background: 'oklch(20%/0.7)', color: 'var(--text-3)',
                            borderRadius: 2, padding: '1px 4px', fontFamily: 'var(--mono-font)' }}>
                {cardIdx + 1}
              </div>
            )}
            {p.custom && (
              <button
                style={{ position: 'absolute', top: 3, right: 3, background: 'oklch(30%/0.7)', border: 'none',
                         color: 'var(--on-accent)', fontSize: 'var(--fs-2xs)', borderRadius: 2, cursor: 'pointer', padding: '1px 4px',
                         opacity: 0, transition: 'opacity 0.1s' }}
                className="lw-pattern-delete-btn"
                title="Delete custom pattern"
                onClick={e => { e.stopPropagation(); if (window.confirm(`Delete "${p.name}"?`)) deleteCustomPattern(p.id); }}>
                ×
              </button>
            )}
            {!p.custom && (
              <button
                className="lw-pattern-fav"
                onClick={e => toggleFav(p.id, e)}
                title={favs.has(p.id) ? 'Remove favorite' : 'Add to favorites'}
                style={{ opacity: favs.has(p.id) ? 1 : 0 }}>
                {favs.has(p.id) ? '★' : '☆'}
              </button>
            )}
          </div>
        ))}
      </div>
        </div>

        <div
          className={`lw-effect-inspector ${inspectorDragActive ? 'is-rotary-drop-target' : ''}`}
          onDragOver={handleInspectorDragOver}
          onDragLeave={handleInspectorDragLeave}
          onDrop={handleInspectorDrop}
        >
          <div className="lw-effect-inspector-head">
            <div>
              <div className="eyebrow">{effectTarget === 'global' ? 'Global tune' : selectedTargetStrip?.name || 'Layer tune'}</div>
              <div className="title">{tuningPattern?.name || tuningPatternId}</div>
            </div>
            <div className={`palette-state ${paletteIsUsed ? 'used' : ''}`}>
              {paletteIsUsed ? 'uses palette' : 'palette unused'}
            </div>
          </div>

          <div
            className={`lw-rotary-control-panel ${rotaryOpen ? 'is-open' : ''}`}
            onDragOver={event => handleRotaryDragOver(event)}
            onDragLeave={() => setRotaryDragOverIndex(null)}
            onDrop={event => handleRotaryDrop(event)}
          >
            <button
              className="lw-rotary-toggle"
              type="button"
              aria-expanded={rotaryOpen}
              onClick={() => setRotaryOpen(open => !open)}
            >
              <span className="lw-rotary-toggle-copy">
                <span className="lw-rotary-title">Rotary button</span>
                <span className="lw-rotary-summary">{rotaryTurnLabel} · {visibleCycleIds.length} push {visibleCycleIds.length === 1 ? 'pattern' : 'patterns'} · on chip after WLED install</span>
                <span className="lw-rotary-preview-line">{rotaryCycleSummary}</span>
              </span>
              <span className="lw-rotary-toggle-action">{rotaryOpen ? 'Close' : 'Organize'}</span>
            </button>

            {rotaryOpen && (
              <div className="lw-rotary-body">
                <div className="lw-rotary-row">
                  <div>
                    <div className="lw-rotary-label">Turn</div>
                    <div className="lw-rotary-hint">Clockwise rotation</div>
                  </div>
                  <div className="lw-rotary-segmented" role="group" aria-label="Rotary turn mapping">
                    <button
                      className={rotaryControls.encoder.rotateDirection === WLED_ENCODER_ROTATE_DIRECTIONS.CLOCKWISE_BRIGHTER ? 'active' : ''}
                      onClick={() => updateRotaryControls({
                        enabled: true,
                        rotateAction: 'brightness',
                        rotateDirection: WLED_ENCODER_ROTATE_DIRECTIONS.CLOCKWISE_BRIGHTER,
                      })}>
                      Brighten
                    </button>
                    <button
                      className={rotaryControls.encoder.rotateDirection === WLED_ENCODER_ROTATE_DIRECTIONS.CLOCKWISE_DIMMER ? 'active' : ''}
                      onClick={() => updateRotaryControls({
                        enabled: true,
                        rotateAction: 'brightness',
                        rotateDirection: WLED_ENCODER_ROTATE_DIRECTIONS.CLOCKWISE_DIMMER,
                      })}>
                      Dim
                    </button>
                  </div>
                </div>

                <div className="lw-rotary-cycle-head">
                  <div>
                    <div className="lw-rotary-label">Push order</div>
                    <div className="lw-rotary-hint">{rotaryCycleIsCustom ? 'Custom WLED preset cycle' : 'Active show order'}</div>
                  </div>
                  <button className="btn btn-ghost" onClick={addCurrentToCycle} disabled={visibleCycleIds.includes(tuningPatternId)}>
                    Add selected
                  </button>
                </div>

                <div className="lw-rotary-cycle-list" aria-label="Rotary push pattern order">
                  {visibleCycleIds.map((cycleId, index) => {
                    const pattern = allPatterns.find(item => item.id === cycleId);
                    return (
                      <div
                        className={`lw-rotary-cycle-item ${rotaryDragOverIndex === index ? 'is-drop-target' : ''}`}
                        key={`${cycleId}-${index}`}
                        draggable
                        onDragStart={event => startPatternDrag(event, cycleId)}
                        onDragOver={event => handleRotaryDragOver(event, index)}
                        onDrop={event => handleRotaryDrop(event, index)}
                      >
                        <span className="lw-rotary-cycle-index">{index + 1}</span>
                        <span className="lw-rotary-cycle-swatch" style={{ background: pattern?.preview || 'var(--surface-2)' }} />
                        <span className="lw-rotary-cycle-name">{pattern?.name || cycleId}</span>
                        <button className="btn btn-ghost" onClick={() => moveCycleId(index, -1)} disabled={index === 0} title="Move earlier">↑</button>
                        <button className="btn btn-ghost" onClick={() => moveCycleId(index, 1)} disabled={index === visibleCycleIds.length - 1} title="Move later">↓</button>
                        <button className="btn btn-ghost" onClick={() => removeCycleId(index)} disabled={visibleCycleIds.length <= 1} title={`Remove ${pattern?.name || cycleId}`}>×</button>
                      </div>
                    );
                  })}
                  <div
                    className={`lw-rotary-dropzone ${rotaryDragOverIndex === visibleCycleIds.length ? 'is-drop-target' : ''}`}
                    onDragOver={event => handleRotaryDragOver(event, visibleCycleIds.length)}
                    onDrop={event => handleRotaryDrop(event, visibleCycleIds.length)}
                  >
                    Drop pattern here
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="lw-studio-panel">
            <div className="lw-studio-panel-head">
              <div>
                <div className="eyebrow">Pattern Studio</div>
                <div className="lw-studio-score">
                  <span>{studioSummary.qualityScore}</span>
                  <small>{studioSummary.qualityGrade}</small>
                </div>
              </div>
              <span className={`lw-runtime-chip is-${studioSummary.compatibility.severity}`}>
                {studioSummary.compatibility.chip}
              </span>
            </div>
            <div className="lw-studio-metrics">
              <span>{studioSummary.installability}</span>
              <span>{studioSummary.controls.authoringSurface}</span>
              <span>{studioSummary.controls.paramCount} controls</span>
              <span>{studioSummary.controls.usesPalette ? 'palette' : 'fixed color'}</span>
            </div>
            <div className="lw-studio-routes">
              {[
                ['WLED', studioSummary.portability.wledBasic],
                ['PORT', studioSummary.portability.wledCustom],
                ['ART', studioSummary.portability.artnet],
                ['SEQ', studioSummary.portability.standaloneSequence],
              ].map(([label, ok]) => (
                <span key={label} className={ok ? 'ready' : ''}>{label}</span>
              ))}
            </div>
            <div className="lw-studio-actions">
              {studioSummary.nextActions.slice(0, 2).map(action => (
                <div key={action.id} className="lw-studio-action">
                  <span>{action.label}</span>
                  <small>{action.detail}</small>
                </div>
              ))}
            </div>
          </div>

      {knobs.length > 0 && (
        <>
          <div className="lw-sec-header">
            <span>Parameters</span>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px' }}
                    onClick={() => knobs.forEach(k => handleParamChange(k.name, k.value))}>
              Reset
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px' }}
                    title="Randomize all params"
                    onClick={() => knobs.forEach(k => {
                      const rand = k.min + Math.random() * (k.max - k.min);
                      handleParamChange(k.name, parseFloat(rand.toFixed(k.step < 0.05 ? 3 : 2)));
                    })}>
              ⟳
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px' }}
                    onClick={savePreset} title="Save current params as preset">
              + Preset
            </button>
          </div>
          <div className="lw-param-groups">
            {groupedKnobs.map(({ group, knobs: groupKnobs }) => (
              <div className="lw-param-group" key={group}>
                <div className="lw-param-group-title">{group}</div>
                <div className="lw-knobs">
                  {groupKnobs.map((k) => {
                    const meta = getParamMeta(k);
                    const value = tuningParams[k.name] ?? k.value;
                    return (
                      <div className="lw-knob" key={k.name}>
                        <div className="lw-knob-name">
                          <span>{meta.label}</span>
                          <small>{meta.desc}</small>
                        </div>
                        <input type="range"
                               aria-label={meta.label}
                               min={usesCurvedParamScale(k, meta) ? 0 : k.min}
                               max={usesCurvedParamScale(k, meta) ? PARAM_SLIDER_STEPS : k.max}
                               step={usesCurvedParamScale(k, meta) ? 1 : k.step}
                               value={paramToSliderValue(value, k, meta)}
                               onChange={e => handleParamChange(k.name, sliderToParamValue(e.target.value, k, meta))}/>
                        <div className="lw-knob-val">
                          {formatParamValue(value, k, meta)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {myPresets.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '4px 0 8px' }}>
              {myPresets.map(key => (
                <button key={key} onClick={() => loadPreset(key)}
                        style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px', background: 'var(--surface-2)',
                                 border: '1px solid var(--border)', borderRadius: 99, cursor: 'pointer',
                                 color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  {key.replace(`${tuningPatternId}/`, '')}
                  <span onClick={e => deletePreset(key, e)}
                        style={{ opacity: 0.5, fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {knobs.length === 0 && (
        <div className="lw-effect-empty">
          This effect has no exposed controls yet.
        </div>
      )}

      <div className="lw-sec-header">
        <span>Palette</span>
        <span className="meta">{paletteIsUsed ? 'used by this effect' : 'not used by this effect'}</span>
      </div>
      <div className="lw-palette-note">
        {paletteIsUsed
          ? 'These swatches feed palette-aware effects and exports.'
          : 'This effect uses fixed colors or hue controls, so palette changes will not visibly affect it.'}
      </div>
      <div className="lw-palette">
        {palette.map((c, i) => (
          <label key={i} className="lw-palette-swatch" style={{ background: c, cursor: 'pointer' }} title={c}>
            <input type="color" value={c}
                   style={{ opacity: 0, position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
                   onChange={e => {
                     if (!onPaletteChange) return;
                     const next = [...palette];
                     next[i] = e.target.value;
                     onPaletteChange(next);
                   }}/>
          </label>
        ))}
      </div>
        </div>
      </div>
    </div>
  );
}

// ── CODE mode ──────────────────────────────────────────────────────────────
export function CodeMode({ patternId, onCodeChange, params, onParamChange }) {
  const editorRef  = useRef(null);
  const viewRef    = useRef(null);
  const [status, setStatus] = useState({ ok: true, error: null, lines: 0, bytes: 0 });
  const [liveKnobs, setLiveKnobs] = useState([]);
  const tryCompileRef = useRef(null);

  const initialCode = getPatternCode(patternId) || '// Select a pattern\nreturn hsv(x, 1, 1);';

  const tryCompile = (code) => {
    const { fn, error } = compile(code);
    const lines = code.split('\n').length;
    const bytes = new TextEncoder().encode(code).length;
    const parsed = parseParamsFromCode(code);
    setStatus({ ok: !error, error, lines, bytes });
    setLiveKnobs(parsed);
    if (onCodeChange) onCodeChange({ code, fn, error, parsedParams: parsed });
  };

  tryCompileRef.current = tryCompile;

  useEffect(() => {
    if (!editorRef.current) return;
    let cancelled = false;
    let view = null;

    async function mountEditor() {
      const [{ EditorView, basicSetup }, { javascript }, { oneDark }] = await Promise.all([
        import('codemirror'),
        import('@codemirror/lang-javascript'),
        import('@codemirror/theme-one-dark'),
      ]);
      if (cancelled || !editorRef.current) return;
      const updateListener = EditorView.updateListener.of(update => {
        if (update.docChanged) tryCompileRef.current?.(update.state.doc.toString());
      });
      view = new EditorView({
        doc: initialCode,
        extensions: [
          basicSetup,
          javascript(),
          oneDark,
          updateListener,
          EditorView.theme({
            '&': { fontSize: '11px', height: '100%' },
            '.cm-scroller': { fontFamily: 'var(--mono-font)', lineHeight: '1.6' },
            '.cm-content': { padding: '6px 0' },
          }),
        ],
        parent: editorRef.current,
      });
      viewRef.current = view;
      tryCompileRef.current?.(initialCode);
    }

    mountEditor().catch(error => {
      if (!cancelled) setStatus({ ok: false, error: error.message || 'Editor failed to load', lines: 0, bytes: 0 });
    });

    return () => {
      cancelled = true;
      viewRef.current = null;
      if (view) view.destroy();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const newCode = getPatternCode(patternId) || '// Select a pattern\nreturn hsv(x, 1, 1);';
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: newCode } });
    tryCompileRef.current?.(newCode);
  }, [patternId]);

  return (
    <div>
      <div className="lw-sec-header">
        <span>Code editor</span>
        <span className="meta">JS · CodeMirror</span>
      </div>
      <div className="lw-code-wrap">
        <div className="lw-code-tabs">
          <div className="lw-code-tab active">pattern.js</div>
          <div className="lw-code-tab">api.md</div>
          <button
            className="btn btn-ghost"
            style={{ marginLeft: 'auto', fontSize: 'var(--fs-2xs)', padding: '2px 7px' }}
            title="Copy code to clipboard"
            onClick={() => {
              const code = viewRef.current?.state.doc.toString() || '';
              navigator.clipboard?.writeText(code);
            }}>
            Copy
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px' }}
            title="Paste code from clipboard"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                if (!viewRef.current || !text.trim()) return;
                viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: text } });
                tryCompileRef.current?.(text);
              } catch {}
            }}>
            Paste
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px' }}
            title="Load library source for this pattern"
            onClick={() => {
              const lib = LIB_PATTERNS.find(p => p.id === patternId);
              if (!lib?.code || !viewRef.current) return;
              viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: lib.code } });
              tryCompileRef.current?.(lib.code);
            }}>
            Load lib
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px' }}
            title="Save as custom pattern (appears in Cards tab)"
            onClick={() => {
              const code = viewRef.current?.state.doc.toString() || '';
              const name = prompt('Pattern name:', '');
              if (!name?.trim()) return;
              saveCustomPattern({ name: name.trim(), code });
            }}>
            Save as…
          </button>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px' }}
            title="Download as .js file"
            onClick={() => {
              const code = viewRef.current?.state.doc.toString() || '';
              const blob = new Blob([`// Lightweaver pattern: ${patternId}\n${code}`], { type: 'text/javascript' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = `${patternId}.js`; a.click();
              URL.revokeObjectURL(url);
            }}>
            ↓ .js
          </button>
        </div>
        <div ref={editorRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }}/>
        <div className="lw-code-footer">
          <span>
            <span className="dot" style={{ background: status.ok ? 'var(--mint)' : 'var(--accent-2)' }}/>
            {status.ok ? 'compiled · 0 errors' : status.error}
          </span>
          <span>{status.lines} lines · {status.bytes} bytes</span>
        </div>
      </div>

      {liveKnobs.length > 0 && (
        <>
          <div className="lw-sec-header">
            <span>Parameters</span>
            <span className="meta">live · from @param</span>
          </div>
          <div className="lw-knobs">
            {liveKnobs.map((k) => {
              const meta = getParamMeta(k);
              const value = params?.[k.name] ?? k.value;
              return (
                <div className="lw-knob" key={k.name}>
                  <div className="lw-knob-name">{k.name}</div>
                  <input type="range"
                         aria-label={`Code parameter ${k.name}`}
                         min={usesCurvedParamScale(k, meta) ? 0 : k.min}
                         max={usesCurvedParamScale(k, meta) ? PARAM_SLIDER_STEPS : k.max}
                         step={usesCurvedParamScale(k, meta) ? 1 : k.step}
                         value={paramToSliderValue(value, k, meta)}
                         onChange={e => onParamChange?.(k.name, sliderToParamValue(e.target.value, k, meta))}/>
                  <div className="lw-knob-val">
                    {formatParamValue(value, k, meta)}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="lw-sec-header">
        <span>Snippets</span>
        <span className="meta">click to insert</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingBottom: 8 }}>
        {[
          ['Rainbow', `return hsv(fract(x + time * 0.3), 1, 1);`],
          ['Fire', `const v = fbm(x * 3, y - time * 0.5, 3);\nreturn hsv(v * 0.12, 1, v);`],
          ['Pulse', `return hsv(0.6, 1, 0.5 + 0.5 * sin(time * 3.14 * 2));`],
          ['Noise', `const v = fbm(x * 4 + time, y * 4, 4);\nreturn hsv(v, 0.8, v);`],
          ['Polar', `const {r, a} = polar(x, y);\nreturn hsv(a / (PI*2) + time * 0.1, 1, 1 - r);`],
          ['Strobe', `return hsv(0, 0, step(0.5, fract(time * params.rate)));`],
          ['Chase', `return hsv(0.6, 1, step(fract(x - time * 0.5), 0.05));`],
        ].map(([label, code]) => (
          <button key={label}
                  className="btn btn-ghost"
                  style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px', borderRadius: 99 }}
                  title={code}
                  onClick={() => {
                    if (!viewRef.current) return;
                    const view = viewRef.current;
                    const pos = view.state.selection.main.head;
                    view.dispatch({ changes: { from: pos, to: pos, insert: `\n// ${label}\n${code}\n` } });
                  }}>
            {label}
          </button>
        ))}
      </div>

      <div className="lw-sec-header"><span>Quick reference</span></div>
      <div style={{ fontFamily: 'var(--mono-font)', fontSize: '10.5px', color: 'var(--text-3)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
        <div><span style={{color:'var(--text-2)'}}>index, x, y, t, time</span> — per-pixel inputs</div>
        <div><span style={{color:'var(--text-2)'}}>stripProgress, stripId</span> — strip-local position</div>
        <div><span style={{color:'var(--text-2)'}}>bass, mid, hi</span> — audio bands 0–1</div>
        <div><span style={{color:'var(--text-2)'}}>hsv(h,s,v)</span> — color, all 0–1 → return&#123;r,g,b&#125;</div>
        <div><span style={{color:'var(--text-2)'}}>noise(x,y), fbm(x,y,oct)</span> — organic noise</div>
        <div><span style={{color:'var(--text-2)'}}>polar(x,y)</span> — &#123;r, a&#125; from center</div>
        <div><span style={{color:'var(--text-2)'}}>beat, beatSin</span> — BPM sync 0–1</div>
        <div><span style={{color:'var(--text-2)'}}>params.*</span> — @param knob values</div>
        <div style={{marginTop:4, color:'var(--text-4)'}}>@param name float default min max</div>
      </div>
    </div>
  );
}

// ── GRAPH mode ─────────────────────────────────────────────────────────────
export function GraphMode({
  patternId,
  onOpenCode,
  onOpenSymmetry,
  masterSpeed,
  setMasterSpeed,
  masterBrightness,
  setMasterBrightness,
  masterSaturation,
  setMasterSaturation,
}) {
  const [sel, setSel] = useState('color');
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(0);
  const [lastChange, setLastChange] = useState('Ready to tune color, motion, and output.');
  const [journeyScrub, setJourneyScrub] = useState(0);
  const undoJourneyRef = useRef(null);
  const { patternParams, setPatternParams, palette, setPalette, symSettings } = useProject();
  const pattern = getPatternById(patternId) || PATTERNS.find(p => p.id === patternId);
  const currentParams = patternParams[patternId] || {};
  const journey = getPatternJourney(currentParams);
  const updateJourney = (patch, message = 'Updated the pattern journey.') => {
    setPatternParams(prev => {
      const existing = prev[patternId] || {};
      undoJourneyRef.current = getPatternJourney(existing);
      const nextJourney = { ...getPatternJourney(existing), enabled: true, ...patch };
      return { ...prev, [patternId]: { ...existing, __journey: nextJourney } };
    });
    setLastChange(message);
  };
  const undoTune = () => {
    const previousJourney = undoJourneyRef.current;
    if (!previousJourney) {
      setLastChange('No earlier tuning step to restore yet.');
      return;
    }
    setPatternParams(prev => {
      const existing = prev[patternId] || {};
      return { ...prev, [patternId]: { ...existing, __journey: previousJourney } };
    });
    undoJourneyRef.current = null;
    setLastChange('Restored the previous tuning step.');
  };
  const setJourneyEnabled = (enabled) => {
    setPatternParams(prev => {
      const existing = prev[patternId] || {};
      return {
        ...prev,
        [patternId]: {
          ...existing,
          __journey: { ...getPatternJourney(existing), enabled },
        },
      };
    });
  };
  const updateJourneyColor = (index, value) => {
    const colorStops = [...journey.colorStops];
    colorStops[index] = normalizeHexColor(value, colorStops[index]);
    updateJourney({ colorStops }, `Changed color stop ${index + 1}.`);
  };
  const addJourneyColor = () => {
    const fallback = journey.colorStops[journey.colorStops.length - 1] || '#ffffff';
    const selectedPaletteColor = palette?.[selectedPaletteIndex];
    updateJourney({
      colorStops: [
        ...journey.colorStops,
        normalizeHexColor(selectedPaletteColor, fallback),
      ],
    }, 'Added another color stop to the loop.');
  };
  const moveJourneyColor = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= journey.colorStops.length) return;
    if (toIndex < 0 || toIndex >= journey.colorStops.length) return;
    const colorStops = [...journey.colorStops];
    const [moved] = colorStops.splice(fromIndex, 1);
    colorStops.splice(toIndex, 0, moved);
    updateJourney({ colorStops }, `Moved color stop ${fromIndex + 1} to position ${toIndex + 1}.`);
  };
  const setJourneyColorFromDrop = (event, targetIndex) => {
    event.preventDefault();
    const sourceIndexText = event.dataTransfer.getData('application/x-lightweaver-journey-index');
    const sourceIndex = Number(sourceIndexText);
    if (sourceIndexText !== '' && Number.isInteger(sourceIndex)) {
      moveJourneyColor(sourceIndex, targetIndex);
      return;
    }

    const droppedColor = event.dataTransfer.getData('application/x-lightweaver-color')
      || event.dataTransfer.getData('text/plain');
    if (/^#?[0-9a-f]{6}$/i.test(droppedColor.trim())) {
      updateJourneyColor(targetIndex, droppedColor);
    }
  };
  const tabs = [
    { id: 'color', label: 'Color' },
    { id: 'motion', label: 'Motion' },
    { id: 'output', label: 'Output' },
  ];
  const resetColor = () => {
    updateJourney({
      colorStops: [...DEFAULT_PATTERN_JOURNEY.colorStops],
      colorMix: DEFAULT_PATTERN_JOURNEY.colorMix,
      saturationEnd: DEFAULT_PATTERN_JOURNEY.saturationEnd,
    }, 'Reset color journey to the starter loop.');
  };
  const resetMotion = () => {
    updateJourney({
      speedStart: DEFAULT_PATTERN_JOURNEY.speedStart,
      speedEnd: DEFAULT_PATTERN_JOURNEY.speedEnd,
      easing: DEFAULT_PATTERN_JOURNEY.easing,
    }, 'Reset motion ramp to the starter feel.');
  };
  const resetOutput = () => {
    setMasterBrightness(1);
    setMasterSaturation(1);
    setLastChange('Reset live output to full brightness and saturation.');
  };
  const applyPaletteToJourney = () => {
    const nextStops = (palette?.length ? palette : DEFAULT_PATTERN_JOURNEY.colorStops)
      .slice(0, 6)
      .map((hex, index) => normalizeHexColor(hex, DEFAULT_PATTERN_JOURNEY.colorStops[index % DEFAULT_PATTERN_JOURNEY.colorStops.length]));
    updateJourney({ colorStops: nextStops }, 'Applied the palette to the color journey.');
  };
  const reverseColorJourney = () => {
    updateJourney({ colorStops: [...journey.colorStops].reverse() }, 'Reversed the color journey.');
  };
  const recipeParts = [
    pattern?.name || patternId,
    journey.enabled ? `${journey.colorStops.length} color journey` : 'static pattern',
    `${journey.speedStart.toFixed(2)}x to ${journey.speedEnd.toFixed(2)}x motion`,
    `${Math.round(masterBrightness * 100)}% brightness`,
    symSettings?.enabled && symSettings.type !== 'none' ? `${symSettings.type} symmetry` : 'no symmetry',
  ];
  const stackRows = [
    {
      label: 'Base pattern',
      value: pattern?.name || patternId,
      detail: 'keeps its own motion, flashes, and spatial structure',
    },
    {
      label: 'Journey layer',
      value: journey.enabled ? `${Math.round(journey.colorMix * 100)}% influence` : 'off',
      detail: 'influences color and speed over time',
    },
    {
      label: 'AI drafts',
      value: 'preview only',
      detail: 'not applied until accepted',
    },
    {
      label: 'Live output',
      value: `${Math.round(masterBrightness * 100)}% bright`,
      detail: symSettings?.enabled && symSettings.type !== 'none'
        ? `brightness, saturation, and ${symSettings.type} symmetry`
        : 'brightness, saturation, and symmetry',
    },
  ];

  return (
    <div className="lw-graph-mode lw-builder-mode">
      <div className="lw-sec-header">
        <span>Tune Pattern</span>
        <span className="meta">{pattern?.name || patternId}</span>
      </div>

      <div className="lw-tune-recipe">
        <div className="lw-tune-recipe-top">
          <div>
            <strong>Now editing</strong>
            <span>{pattern?.name || patternId}</span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={undoTune}>
            Undo tuning
          </button>
        </div>
        <div className="lw-tune-recipe-line">
          <strong>Pattern recipe</strong>
          <span>{recipeParts.join(' + ')}</span>
        </div>
        <div className="lw-tune-recipe-line">
          <strong>Last change</strong>
          <span>{lastChange}</span>
        </div>
      </div>

      <div className="lw-effect-stack" aria-label="Pattern effect stack">
        <div className="lw-effect-stack-head">
          <strong>Effect stack</strong>
          <span>top controls influence lower layers</span>
        </div>
        {stackRows.map(row => (
          <div className="lw-effect-stack-row" key={row.label}>
            <span className="lw-effect-stack-pin" aria-hidden="true" />
            <div>
              <strong>{row.label}</strong>
              <span>{row.detail}</span>
            </div>
            <em>{row.value}</em>
          </div>
        ))}
      </div>

      <div className="lw-journey-panel">
        <label className="lw-journey-toggle">
          <input
            type="checkbox"
            checked={!!journey.enabled}
            onChange={event => setJourneyEnabled(event.target.checked)}
          />
          <span>
            <strong>Pattern journey</strong>
            <small>Build the long phrase inside this pattern.</small>
          </span>
        </label>
        <BuilderSlider
          label="Duration"
          min={5}
          max={120}
          step={1}
          value={journey.duration}
          onChange={duration => updateJourney({ duration }, `Set journey length to ${Math.round(duration)} seconds.`)}
          readout={`${Math.round(journey.duration)}s`}
        />
        <div className="lw-builder-segment" aria-label="Journey loop mode">
          {[
            ['repeat', 'Repeat'],
            ['pingpong', 'Ping-pong'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={journey.loop === value ? 'active' : ''}
              onClick={() => updateJourney({ loop: value }, value === 'repeat' ? 'Journey now loops back to the first color.' : 'Journey now runs forward then backward.')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="lw-builder-tabs" role="tablist" aria-label="Pattern builder sections">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sel === tab.id}
            className={sel === tab.id ? 'active' : ''}
            onClick={() => setSel(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="lw-builder-pane">
        {sel === 'color' && (
          <>
            <PaletteEditor
              palette={palette}
              selectedIndex={selectedPaletteIndex}
              setSelectedIndex={setSelectedPaletteIndex}
              onPaletteChange={setPalette}
            />
            <div className="lw-builder-block">
              <div className="lw-builder-block-head">
                <strong>Color journey</strong>
                <span>Loops back to first</span>
              </div>
              <div className="lw-color-timeline" aria-label="Color journey timeline">
                <div
                  className="lw-color-timeline-track"
                  style={{ background: `linear-gradient(90deg, ${journey.colorStops.join(', ')}, ${journey.colorStops[0]})` }}
                />
                <span className="lw-color-timeline-playhead" style={{ left: `${journeyScrub}%` }}/>
              </div>
              <BuilderSlider
                label="Scrub"
                min={0}
                max={100}
                step={1}
                value={journeyScrub}
                onChange={value => {
                  setJourneyScrub(value);
                  setLastChange(`Previewing ${Math.round(value)}% through the journey.`);
                }}
                readout={`${Math.round(journeyScrub)}%`}
              />
              <div className="lw-journey-stop-list" aria-label="Color journey stops">
                {journey.colorStops.map((hex, index) => (
                  <div
                    key={`${hex}-${index}`}
                    className="lw-journey-stop"
                    draggable
                    aria-label={`Color stop ${index + 1}`}
                    onDragStart={event => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-lightweaver-journey-index', String(index));
                    }}
                    onDragOver={event => event.preventDefault()}
                    onDrop={event => setJourneyColorFromDrop(event, index)}
                  >
                    <span className="lw-journey-stop-handle" aria-hidden="true">::</span>
                    <label>
                      <span>{index === 0 ? '1 Start' : `${index + 1}`}</span>
                      <input
                        aria-label={`Color stop ${index + 1}`}
                        type="color"
                        value={hex}
                        onChange={event => updateJourneyColor(index, event.target.value)}
                      />
                    </label>
                  </div>
                ))}
                <button
                  className="lw-add-journey-stop"
                  type="button"
                  aria-label="Add color stop"
                  onClick={addJourneyColor}
                >
                  <span aria-hidden="true">+</span>
                  <strong>Add color stop</strong>
                </button>
              </div>
              <div className="lw-builder-action-row">
                <button className="btn btn-ghost" type="button" onClick={applyPaletteToJourney}>
                  Apply palette to journey
                </button>
                <button className="btn btn-ghost" type="button" onClick={reverseColorJourney}>
                  Reverse color order
                </button>
                <button className="btn btn-ghost" type="button" onClick={resetColor}>
                  Reset Color
                </button>
              </div>
              <BuilderSlider
                label="Color influence"
                min={0}
                max={1}
                step={0.01}
                value={journey.colorMix}
                onChange={colorMix => updateJourney({ colorMix }, `Color influence is now ${Math.round(colorMix * 100)}%.`)}
                readout={`${Math.round(journey.colorMix * 100)}%`}
              />
              <div className="lw-tune-explainer">
                <strong>Pattern stays underneath</strong>
                <span>Steers journey colors without replacing the pattern underneath.</span>
              </div>
              <BuilderSlider
                label="End intensity"
                min={0}
                max={1}
                step={0.01}
                value={journey.saturationEnd}
                onChange={saturationEnd => updateJourney({ saturationEnd }, `Ending color intensity is now ${Math.round(saturationEnd * 100)}%.`)}
                readout={`${Math.round(journey.saturationEnd * 100)}%`}
              />
            </div>
          </>
        )}

        {sel === 'motion' && (
          <div className="lw-builder-block">
            <div className="lw-builder-block-head">
              <strong>Live speed</strong>
              <span>global</span>
            </div>
            <div className="lw-tune-explainer">
              <strong>Speed story</strong>
              <span>Set how the pattern starts, where it ends, and how smooth that change feels.</span>
            </div>
            <BuilderSlider
              label="Speed"
              min={0}
              max={4}
              step={0.01}
              value={masterSpeed}
              onChange={value => {
                setMasterSpeed(value);
                setLastChange(`Live speed is now ${value.toFixed(2)}x.`);
              }}
              readout={`${masterSpeed.toFixed(2)}x`}
            />
            <div className="lw-builder-block-head">
              <strong>Motion journey</strong>
              <span>speed ramp</span>
            </div>
            <BuilderSlider
              label="Start"
              min={0}
              max={4}
              step={0.01}
              value={journey.speedStart}
              onChange={speedStart => updateJourney({ speedStart }, `Motion now starts at ${speedStart.toFixed(2)}x.`)}
              readout={`${journey.speedStart.toFixed(2)}x`}
            />
            <BuilderSlider
              label="End"
              min={0}
              max={4}
              step={0.01}
              value={journey.speedEnd}
              onChange={speedEnd => updateJourney({ speedEnd }, `Motion now ends at ${speedEnd.toFixed(2)}x.`)}
              readout={`${journey.speedEnd.toFixed(2)}x`}
            />
            <div className="lw-builder-segment" aria-label="Journey easing">
              {[
                ['smooth', 'Smooth'],
                ['linear', 'Linear'],
                ['ease-out', 'Ease out'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={journey.easing === value ? 'active' : ''}
                  onClick={() => updateJourney({ easing: value }, `Motion easing set to ${label}.`)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="lw-builder-action-row">
              <button className="btn btn-ghost" type="button" onClick={resetMotion}>
                Reset Motion
              </button>
            </div>
          </div>
        )}

        {sel === 'output' && (
          <div className="lw-builder-block">
            <div className="lw-builder-block-head">
              <strong>Live output</strong>
              <span>applies globally</span>
            </div>
            <div className="lw-tune-explainer">
              <strong>What is live right now</strong>
              <span>Brightness and saturation affect the preview immediately and carry into the hardware output.</span>
            </div>
            <BuilderSlider
              label="Brightness"
              min={0}
              max={1}
              step={0.01}
              value={masterBrightness}
              onChange={value => {
                setMasterBrightness(value);
                setLastChange(`Brightness is now ${Math.round(value * 100)}%.`);
              }}
              readout={`${Math.round(masterBrightness * 100)}%`}
            />
            <BuilderSlider
              label="Saturation"
              min={0}
              max={1}
              step={0.01}
              value={masterSaturation}
              onChange={value => {
                setMasterSaturation(value);
                setLastChange(`Saturation is now ${Math.round(value * 100)}%.`);
              }}
              readout={`${Math.round(masterSaturation * 100)}%`}
            />
            <div className="lw-builder-action-row">
              <button className="btn btn-ghost" type="button" onClick={resetOutput}>
                Reset Output
              </button>
              <button className="btn" type="button" onClick={onOpenSymmetry}>
                Open Symmetry
              </button>
              <button className="btn btn-ghost" type="button" onClick={onOpenCode}>
                Open Code
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
