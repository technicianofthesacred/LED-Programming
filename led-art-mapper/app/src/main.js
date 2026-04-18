/**
 * main.js — state, editor, animation loop, event wiring
 *
 * Workflow overview:
 *   1. User imports an Illustrator SVG → artwork loads as dimmed background,
 *      each top-level <g> (layer) appears in the Sections modal with auto
 *      LED counts from pitch + scale.
 *   2. User confirms → strips added, section panel populated.
 *   3. Clicking a section row highlights the corresponding artwork layer.
 *   4. Eye button toggles section path + artwork layer visibility.
 *   5. Run a pattern → live LED dot animation over the artwork.
 *   6. Export ledmap.json → upload to WLED.
 */

import { EditorView, basicSetup }                    from 'codemirror';
import { javascript }                                from '@codemirror/lang-javascript';
import { oneDark }                                   from '@codemirror/theme-one-dark';

import { CanvasManager }                             from './canvas.js';
import { samplePath, assignIndices, getAllPixels }   from './mapper.js';
import { compile, evalPixel }                        from './patterns.js';
import { PreviewRenderer }                           from './preview.js';
import { toWLEDLedmap, toFastLED, toCSV, download } from './export.js';
import { initFlash }                                 from './flash.js';
import { PATTERNS }                                  from './patterns-library.js';

const _LIBRARY_IDS = new Set(PATTERNS.map(p => p.id));

// ── LED strip type definitions ────────────────────────────────────────────

const LED_TYPES = [
  { id: 'ws2812b',  name: 'WS2812B',           densities: [30, 60, 96, 144] },
  { id: 'sk6812',   name: 'SK6812 RGBW',        densities: [30, 60, 96, 144] },
  { id: 'apa102',   name: 'APA102 / SK9822',    densities: [30, 60, 96, 144] },
  { id: 'ws2811',   name: 'WS2811 (pixel)',      densities: [50, 100] },
  { id: 'neopixel', name: 'NeoPixel Ring',       densities: [16, 24, 32, 40, 60] },
  { id: 'custom',   name: 'Custom density',      densities: [] },
];

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  strips: [],

  artworkLayers:     [],  // [{ layerId, name, pathData, svgLength, subPaths }] — set on SVG import
  artworkLayerState: [],  // persisted { layerId, _hidden, _color } — restored on project load
  layerGroups:       [],  // [{groupId, name, _hidden, _expanded, members:[{layer,subPath}]}]
  layerOrder:        [],  // ordered [{type:'layer'|'group', id}]
  panelChecked:      new Set(), // pathIds checked in layers panel for grouping
  inspectorLayerId:  null,
  pathSelection:     [],  // [{layer, subPath}] — paths selected on canvas for group creation
  ledTypeId:        'ws2812b', // global LED strip type for this project

  // B1: Color palette — six named swatches, values are CSS hex strings
  palette: ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#ff9f1c'],

  // B2: BPM tap tempo
  bpm:       120,
  beatStart: 0,
  tapTimes:  [],

  // B3: Scene presets
  scenes:        [],
  activeSceneId: null,

  // B4: Pattern @param knobs — { [patternId]: { [paramName]: currentValue } }
  patternParams: {},

  _svgSource: null, // stored for localStorage restore across HMR reloads

  patterns: [...PATTERNS],


  activePatternId:  'rainbow',
  compiledFns:      new Map(), // patternId → compiled Function
  normalisedPixels: [],

  animating:   false,
  rafId:       null,
  t:           0,        // global elapsed seconds (unscaled)
  time:        0,        // global 0–1 cycling
  lastTs:      null,
  fpsHistory:  [],

  masterSpeed:      1.0,  // multiplies every section's speed
  masterBrightness: 1.0,  // multiplies all LED output (A2)
  stripTimes:  new Map(), // id → { t, time } — per-strip accumulated time

  // C2: WLED live push
  wledIp:          '',
  wledConnected:   false,
  wledPushHandle:  null,
  wledWs:          null,   // WebSocket connection to WLED
  lastFrame:       new Uint8Array(0),

  // C3: Section groups
  groups: [], // [{id, name, collapsed, stripIds, speed, brightness, hueShift, visible, patternId}]

  // Feature 5: WLED push counter
  wledPushCount: 0,

  // Feature 6: Master saturation
  masterSaturation: 1.0,  // 0 = greyscale, 1 = full colour

  // LFO automation for pattern params
  paramLfos: {}, // key: `${patternId}__${paramName}` → { enabled, shape, rate, depth }

  // MIDI
  midiAccess:   null,
  midiMappings: {}, // CC number → { target, min, max }
  midiLearn:    false,
  midiLearnTarget: null,

  // Feature 7: Gamma correction
  gammaEnabled: false,
  gammaValue:   2.2,

  // Feature 11: Canvas zoom + pan
  canvasZoom:    1.0,
  canvasPanX:    0,
  canvasPanY:    0,
  canvasPanning: false,
  spaceHeld:     false,
  spaceDragged:  false,

  selectedIds: new Set(),   // multi-select
  connections: [],          // [{fromId, toId}] — strip chain links
  chainById:   new Map(),   // stripId → {chainId, offset, total} — built by _buildChainMap

  // Feature 14: Scene crossfade
  crossfadeDuration: 1000, // ms
  _crossfadeFrom:    null, // snapshot of pixel RGB values at crossfade start
  _crossfadeStart:   null, // timestamp
  _crossfadeTarget:  null, // scene id to reach
};

// BUG 4: pre-allocated reusable buffer for WLED push (avoids Array.from allocation every 40ms)
let _wledBuf = [];

// ── Undo / Redo ───────────────────────────────────────────────────────────────
const _history = [];
let   _future  = [];
const _MAX_HISTORY = 50;

function _snapshot() {
  return {
    strips:      state.strips.map(({ pixels: _px, ...s }) => JSON.parse(JSON.stringify(s))),
    connections: JSON.parse(JSON.stringify(state.connections)),
    groups:      JSON.parse(JSON.stringify(state.groups)),
  };
}

function _pushHistory() {
  if (_history.length >= _MAX_HISTORY) _history.shift();
  _history.push(_snapshot());
  _future.length = 0;
  _updateUndoRedoUI();
}

function _restoreSnapshot(snap) {
  canvasManager.clearCanvas();
  state.strips = [];
  state.stripTimes.clear();
  for (const stripData of snap.strips) {
    const strip = { ...stripData };
    canvasManager.addStrip(strip);
    const pathEl = canvasManager.getPathEl(strip.id);
    strip.svgLength = strip.svgLength ?? pathEl?.getTotalLength() ?? 0;
    strip.pixels    = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
    if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    if (strip.offsetX || strip.offsetY) {
      const ox = strip.offsetX || 0, oy = strip.offsetY || 0;
      strip.pixels.forEach(px => { px.x += ox; px.y += oy; });
    }
    state.strips.push(strip);
    state.stripTimes.set(strip.id, { t: 0, time: 0 });
  }
  state.connections = snap.connections;
  state.groups      = snap.groups;
  _reindex();
  _rebuildNorm();
  state.strips.forEach(s => canvasManager.setStripDots(s.id, s.pixels));
  canvasManager.renderConnections(state.connections);
  renderStripsList();
  syncExportInfo();
  _updateEmptyState();
  _markDirty();
}

function _updateUndoRedoUI() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = _history.length === 0;
  if (redoBtn) redoBtn.disabled = _future.length  === 0;
}

function undo() {
  if (!_history.length) return;
  _future.push(_snapshot());
  _restoreSnapshot(_history.pop());
  _updateUndoRedoUI();
}

function redo() {
  if (!_future.length) return;
  _history.push(_snapshot());
  _restoreSnapshot(_future.pop());
  _updateUndoRedoUI();
}

// ── Compass direction control state ──────────────────────────────────────────
let _compassStripId      = null;
let _compassDragging     = false;
let _compassMoveHandler  = null;
let _compassUpHandler    = null;

const _TAU = Math.PI * 2;

function _drawCompass(canvas, angleDeg) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const r  = Math.min(cx, cy) - 2;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = '#0d0d1e';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, _TAU); ctx.fill();

  // Tick marks at 8 compass points
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * _TAU - Math.PI / 2;
    const isCard = i % 2 === 0;
    const inner = r - (isCard ? 5 : 3);
    ctx.strokeStyle = isCard ? '#3a3a4a' : '#222232';
    ctx.lineWidth   = isCard ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * (r - 0.5), cy + Math.sin(a) * (r - 0.5));
    ctx.stroke();
  }

  if (angleDeg == null) {
    // Omnidirectional: dashed ring + center dot
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = '#3a3a5a';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.52, 0, _TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#444';
    ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, _TAU); ctx.fill();
  } else {
    const emitRad = (angleDeg - 90) * Math.PI / 180;
    const spread  = Math.PI / 3; // ±60°

    // Coverage cone fill
    ctx.fillStyle = 'rgba(76,201,240,0.15)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r - 2, emitRad - spread, emitRad + spread);
    ctx.closePath(); ctx.fill();

    // Cone edge lines
    ctx.strokeStyle = 'rgba(76,201,240,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Direction arrow
    const al = r * 0.72;
    const ax = cx + Math.cos(emitRad) * al;
    const ay = cy + Math.sin(emitRad) * al;
    ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ax, ay); ctx.stroke();

    // Arrowhead
    const hs = 5, ha = Math.PI / 6;
    ctx.fillStyle = '#4cc9f0';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - hs * Math.cos(emitRad - ha), ay - hs * Math.sin(emitRad - ha));
    ctx.lineTo(ax - hs * Math.cos(emitRad + ha), ay - hs * Math.sin(emitRad + ha));
    ctx.closePath(); ctx.fill();

    // Center dot
    ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, _TAU); ctx.fill();
  }
}

function _applyCompassAngle(e) {
  const strip = state.strips.find(s => s.id === _compassStripId);
  if (!strip) return;
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('popup-compass'));
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dx = e.clientX - (rect.left + rect.width  / 2);
  const dy = e.clientY - (rect.top  + rect.height / 2);
  if (Math.hypot(dx, dy) < 5) return;
  strip.emitAngle = Math.round(((Math.atan2(dy, dx) * 180 / Math.PI) + 90 + 360) % 360);
  _drawCompass(canvas, strip.emitAngle);
  const lbl = document.getElementById('popup-emit-label');
  if (lbl) lbl.textContent = `${strip.emitAngle}°`;
  _markDirty();
  if (previewRenderer._coverageColorMap) previewRenderer.showCoverage(_coverageColorMap(), _coverageAngleMap());
  if (previewRenderer.directedMode) previewRenderer.setEmitAngles(_coverageAngleMap());
  canvasManager.refreshEmitDirection(strip.id);
}

function _coverageAngleMap() {
  return new Map(state.strips.map(s => [s.id, s.emitAngle ?? null]));
}

// ── DOM ───────────────────────────────────────────────────────────────────

const svgEl   = /** @type {SVGSVGElement}  */ (document.getElementById('drawing-canvas'));
const wrapper = /** @type {HTMLDivElement} */ (document.querySelector('.canvas-wrapper'));

// ── Toast & confirm helpers ───────────────────────────────────────────────

let _toastTimer = null;
function showToast(msg, type = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (type ? ` toast-${type}` : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

/**
 * Async confirm dialog (replaces native confirm()).
 * Returns a Promise<boolean>.
 */
function showConfirm(msg) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-overlay';
      overlay.className = 'confirm-overlay hidden';
      overlay.innerHTML = `
        <div class="confirm-box">
          <div class="confirm-msg" id="confirm-msg"></div>
          <div class="confirm-actions">
            <button id="confirm-cancel">Cancel</button>
            <button id="confirm-ok" class="btn-primary">OK</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    document.getElementById('confirm-msg').textContent = msg;
    overlay.classList.remove('hidden');
    const cleanup = (result) => {
      overlay.classList.add('hidden');
      resolve(result);
    };
    document.getElementById('confirm-ok').onclick    = () => cleanup(true);
    document.getElementById('confirm-cancel').onclick = () => cleanup(false);
    overlay.onclick = e => { if (e.target === overlay) cleanup(false); };
  });
}

function showPrompt(msg, defaultVal = '') {
  return new Promise(resolve => {
    let overlay = document.getElementById('prompt-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'prompt-overlay';
      overlay.className = 'confirm-overlay hidden';
      overlay.innerHTML = `
        <div class="confirm-box">
          <div class="confirm-msg" id="prompt-msg"></div>
          <input id="prompt-input" type="text" style="width:100%;margin:4px 0 0;font:inherit;font-size:12px;background:#0a0a0a;color:#d0d0d0;border:1px solid #252525;border-radius:4px;padding:4px 7px" />
          <div class="confirm-actions" style="margin-top:8px">
            <button id="prompt-cancel">Cancel</button>
            <button id="prompt-ok" class="btn-primary">OK</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    document.getElementById('prompt-msg').textContent = msg;
    const input = document.getElementById('prompt-input');
    input.value = defaultVal;
    overlay.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const cleanup = (result) => {
      overlay.classList.add('hidden');
      resolve(result);
    };
    const ok = () => cleanup(input.value.trim() || null);
    document.getElementById('prompt-ok').onclick     = ok;
    document.getElementById('prompt-cancel').onclick = () => cleanup(null);
    overlay.onclick = e => { if (e.target === overlay) cleanup(null); };
    input.onkeydown = e => {
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') cleanup(null);
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────

const _getPitch   = () => parseFloat(document.getElementById('pitch').value)      || 16.6;
const _getPxPerMm = () => parseFloat(document.getElementById('px-per-mm').value)  || 2.8346;
const _toMm       = svgLen => svgLen / _getPxPerMm();
const _fmtMm      = mm => mm < 10 ? mm.toFixed(1) : Math.round(mm).toString();

// ── CodeMirror ────────────────────────────────────────────────────────────

let cmEditor = /** @type {EditorView|null} */ (null);

function initEditor(code) {
  if (cmEditor) cmEditor.destroy();
  cmEditor = new EditorView({
    doc: code,
    extensions: [
      basicSetup, javascript(), oneDark,
      EditorView.theme({
        '&':                { height: '100%' },
        '.cm-scroller':     { overflow: 'auto' },
        '.cm-content':      { fontFamily: "'SF Mono','Fira Code','Cascadia Code',ui-monospace,monospace", fontSize: '12px', lineHeight: '1.5' },
        '.cm-gutterElement':{ fontSize: '10px', lineHeight: '1.5' },
      }),
      EditorView.updateListener.of(u => { if (u.docChanged) _scheduleRecompile(); }),
    ],
    parent: document.getElementById('pattern-editor'),
  });
}

const _editorCode    = () => cmEditor?.state.doc.toString() ?? '';
const _setEditorCode = code => cmEditor?.dispatch({ changes: { from: 0, to: cmEditor.state.doc.length, insert: code } });

// ── Community Effects Library ─────────────────────────────────────────────

const EFFECT_LIBRARY = [
  {
    category: 'Classics',
    effects: [
      { id: 'lib-rainbow',     name: 'Rainbow',       preview: 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
        code: `return hsv(fract(index / pixelCount + time), 1, 1);` },
      { id: 'lib-rainbow-x',  name: 'Rainbow XY',    preview: 'linear-gradient(135deg,#f00,#ff0,#0f0,#0ff,#00f)',
        code: `return hsv(fract(x * 0.7 + y * 0.3 + time * 0.5), 1, 1);` },
      { id: 'lib-fire',       name: 'Fire',          preview: 'linear-gradient(0deg,#300,#c20,#f60,#fc0,#fff)',
        code: `// @param speed float 1.5 0.3 4.0\nconst n = noise(x * 4, y * 6 - t * params.speed);\nconst v = clamp(n * 1.8, 0, 1);\nreturn hsv(lerp(0, 0.09, n), 1, v);` },
      { id: 'lib-sparkle',    name: 'Sparkle',       preview: 'radial-gradient(circle at 25% 50%,#fff 0%,transparent 6%),radial-gradient(circle at 70% 30%,#fff 0%,transparent 5%),#040412',
        code: `// @param density float 0.97 0.7 0.999\nconst s = randomF(index + floor(t * 15) * 997);\nreturn { r: s > params.density ? 255 : 0, g: s > params.density ? 255 : 0, b: s > params.density ? 255 : 0 };` },
      { id: 'lib-chase',      name: 'Color Chase',   preview: 'linear-gradient(90deg,#04040f 35%,#4af 50%,#fff 51%,#4af 65%,#04040f)',
        code: `// @param width float 0.04 0.005 0.2\nconst pos = fract(time);\nconst d = abs(index / pixelCount - pos);\nreturn hsv(pos, 1, clamp(1 - d / params.width, 0, 1));` },
      { id: 'lib-comet',      name: 'Comet',         preview: 'linear-gradient(90deg,#000,#002,#04f,#8af,#fff)',
        code: `// @param tail float 0.12 0.02 0.5\nconst pos = fract(time * 0.7);\nconst d   = fract(index / pixelCount - pos + 1);\nconst v   = d < params.tail ? pow(1 - d / params.tail, 2) : 0;\nreturn hsv(0.58 + d * 0.1, 0.8, v);` },
    ],
  },
  {
    category: 'Pulse & Breathe',
    effects: [
      { id: 'lib-breathe',    name: 'Breathe',       preview: 'radial-gradient(ellipse,#0d6 0%,#042 50%,#010d08 100%)',
        code: `// @param hue float 0.35 0 1\n// @param rate float 0.4 0.05 2\nconst v = pow(sin(t * params.rate * TAU) * 0.5 + 0.5, 2);\nreturn hsv(params.hue, 0.9, v);` },
      { id: 'lib-heartbeat',  name: 'Heartbeat',     preview: 'radial-gradient(ellipse,#f44 0%,#400 70%,#000 100%)',
        code: `// @param bps float 1.2 0.3 3.0\nconst phase = fract(t * params.bps);\nconst v = phase < 0.08 ? phase / 0.08 : phase < 0.18 ? (0.18 - phase) / 0.1 : phase < 0.28 ? (phase - 0.18) / 0.1 * 0.6 : phase < 0.38 ? (0.38 - phase) / 0.1 * 0.6 : 0;\nreturn hsv(0.02, 1, v);` },
      { id: 'lib-strobe',     name: 'Strobe',        preview: 'linear-gradient(90deg,#fff,#000,#fff,#000)',
        code: `// @param rate float 10 1 30\nconst v = sin(t * params.rate * TAU) > 0 ? 1 : 0;\nreturn { r: v*255, g: v*255, b: v*255 };` },
      { id: 'lib-beat-pulse', name: 'Beat Pulse',    preview: 'radial-gradient(ellipse,#a0f 20%,#308 70%,#000 100%)',
        code: `// @param hue float 0.75 0 1\nconst v = pow(1 - beat, 4);\nreturn hsv(params.hue, 1, v);` },
    ],
  },
  {
    category: 'Motion',
    effects: [
      { id: 'lib-theater',    name: 'Theater Chase', preview: 'linear-gradient(90deg,#fff 0%,#fff 25%,#000 25%,#000 50%,#fff 50%,#fff 75%,#000 75%)',
        code: `// @param spacing int 3 2 8\nconst v = (index + floor(time * 10)) % params.spacing === 0 ? 1 : 0;\nreturn hsv(fract(time), 1, v);` },
      { id: 'lib-larson',     name: 'Larson Scanner',preview: 'linear-gradient(90deg,#000,#f00,#fff,#f00,#000)',
        code: `// @param width float 0.06 0.01 0.2\nconst pos = (sin(t * 1.2) + 1) * 0.5;\nconst d   = abs(index / pixelCount - pos);\nconst v   = clamp(1 - d / params.width, 0, 1);\nreturn { r: Math.round(v * 255), g: 0, b: 0 };` },
      { id: 'lib-meteor',     name: 'Meteor Rain',   preview: 'linear-gradient(180deg,#fff,#aaf,#004,#000)',
        code: `// @param count int 3 1 8\n// @param tail float 0.08 0.01 0.3\nlet r = 0, g = 0, b = 0;\nfor (let m = 0; m < params.count; m++) {\n  const offset = randomF(m * 91) * 65.536;\n  const pos = fract((t + offset) / 4);\n  const d   = fract(index / pixelCount - pos + 1);\n  const v   = d < params.tail ? pow(1 - d / params.tail, 1.5) : 0;\n  r += v * 180; g += v * 200; b += v * 255;\n}\nreturn { r: min(r,255), g: min(g,255), b: min(b,255) };` },
      { id: 'lib-wipe',       name: 'Color Wipe',    preview: 'linear-gradient(90deg,#06d 0%,#06d 50%,#000 50%)',
        code: `const pos = fract(time);\nconst lit = index / pixelCount < pos;\nreturn hsv(pos * 3, 1, lit ? 1 : 0.02);` },
      { id: 'lib-running',    name: 'Running Lights',preview: 'linear-gradient(90deg,#fff,#00f,#fff,#00f,#fff)',
        code: `// @param segments int 5 2 20\nconst v = pow(sin((index / pixelCount * params.segments - time) * TAU) * 0.5 + 0.5, 2);\nreturn hsv(0.6, 0.8, v);` },
      { id: 'lib-beat-trail', name: 'Beat Trail', preview: 'linear-gradient(90deg,#000,#f0f,#a0f,#000)',
        code: `// @param hue float 0.8 0 1\n// @param decay float 0.06 0.01 0.2\nconst pos = fract(time);\nconst d = fract(index / pixelCount - pos + 1);\nconst v = d < params.decay ? pow(1 - d / params.decay, 1.5) : 0;\nconst flash = pow(1 - beat, 8);\nreturn hsv(params.hue, 1, max(v, flash));` },
      { id: 'lib-bouncing-balls', name: 'Bouncing Balls', preview: 'linear-gradient(90deg,#000,#f80,#000,#08f,#000,#0f4,#000)',
        code: `// @param count int 3 1 8\nlet r = 0, g = 0, b = 0;\nfor (let i = 0; i < params.count; i++) {\n  const phase = randomF(i * 31) * TAU;\n  const pos = (sin(t * (0.4 + i * 0.15) + phase) + 1) * 0.5;\n  const d = abs(index / pixelCount - pos);\n  const v = clamp(1 - d * 30, 0, 1);\n  const hue = randomF(i * 7.3);\n  const col = hsv(hue, 1, v);\n  r += col.r; g += col.g; b += col.b;\n}\nreturn { r: min(r,255), g: min(g,255), b: min(b,255) };` },
    ],
  },
  {
    category: 'Color',
    effects: [
      { id: 'lib-solid',      name: 'Solid Color',   preview: 'linear-gradient(90deg,#f60,#f60)',
        code: `// @param hue float 0.08 0 1\n// @param sat float 1.0 0 1\nreturn hsv(params.hue, params.sat, 1);` },
      { id: 'lib-palette-cycle', name: 'Palette Cycle', preview: 'linear-gradient(90deg,#f66,#fa0,#0d6,#08f,#f0f,#fa0)',
        code: `const i = floor(time * palette.length) % palette.length;\nconst j = (i + 1) % palette.length;\nconst f = fract(time * palette.length);\nconst c = { r: lerp(palette[i].r, palette[j].r, f), g: lerp(palette[i].g, palette[j].g, f), b: lerp(palette[i].b, palette[j].b, f) };\nreturn { r: c.r*255, g: c.g*255, b: c.b*255 };` },
      { id: 'lib-gradient',   name: 'Gradient',      preview: 'linear-gradient(90deg,#f66,#fa0,#0d6,#08f)',
        code: `const seg = (index / pixelCount) * (palette.length - 1);\nconst i = floor(seg), f = fract(seg);\nconst a = palette[i], b2 = palette[min(i+1, palette.length-1)];\nreturn { r: lerp(a.r,b2.r,f)*255, g: lerp(a.g,b2.g,f)*255, b: lerp(a.b,b2.b,f)*255 };` },
      { id: 'lib-lava',       name: 'Lava',          preview: 'linear-gradient(180deg,#000,#300,#800,#f40,#ff8,#fff)',
        code: `const n = noise(x * 3 + t * 0.3, y * 4 - t * 0.5);\nconst v = clamp(n * 2, 0, 1);\nreturn hsv(lerp(0.0, 0.08, v), 1, v);` },
      { id: 'lib-ocean',      name: 'Ocean',         preview: 'linear-gradient(90deg,#004,#006,#088,#0af,#06d,#004)',
        code: `const n = noise(x * 4 - t * 0.4, y * 3 + t * 0.2) * 0.5 + noise(x * 2, y * 2 + t * 0.3) * 0.5;\nreturn hsv(0.55 + n * 0.08, 0.9, 0.4 + n * 0.6);` },
      { id: 'lib-aurora',     name: 'Aurora',        preview: 'linear-gradient(180deg,#000,#060,#0d8,#08f,#40f,#000)',
        code: `const n  = noise(x * 2 + t * 0.15, 0);\nconst n2 = noise(x * 3 - t * 0.1, 0.5);\nconst h  = 0.33 + n * 0.25;\nconst v  = clamp(sin(y * TAU + n2 * 4) * 0.5 + 0.5, 0, 1);\nreturn hsv(h, 0.9, v * (0.4 + n * 0.6));` },
      { id: 'lib-fire-fbm', name: 'Fire FBM', preview: 'linear-gradient(0deg,#200,#900,#e40,#fa0,#fff)',
        code: `// @param intensity float 1.8 0.5 3\n// @param rise float 1.2 0.2 3\nconst n = fbm(x*4, y*5 - t*params.rise, 5);\nconst v = clamp(n * params.intensity, 0, 1);\nreturn hsv(lerp(0, 0.1, n), 1, v);` },
      { id: 'lib-deep-ocean', name: 'Deep Ocean', preview: 'linear-gradient(180deg,#001,#003,#016,#048,#07a,#04d)',
        code: `const n = fbm(x*3-t*0.3, y*2+t*0.15, 5);\nconst n2 = fbm(x*1.5+0.5, y*1.5-t*0.2, 4);\nconst depth = 1 - y;\nreturn hsv(0.58 + n*0.07, 0.95, (0.2 + n*0.5) * (0.4 + depth*0.6 + n2*0.3));` },
      { id: 'lib-crystal', name: 'Crystal', preview: 'linear-gradient(135deg,#adf,#fad,#dfa,#adf)',
        code: `// @param facets float 8 3 20\nconst p = polar(x, y);\nconst f = fract(p.a * params.facets);\nconst edgeDist = min(f, 1-f) * 2;\nconst shimmer = noise(p.r*8 + t*0.5, p.a*params.facets + t*0.3);\nreturn hsv(fract(p.a * 0.5 + time*0.2), 0.4+edgeDist*0.5, edgeDist*0.8 + shimmer*0.4);` },
    ],
  },
  {
    category: '2D / XY',
    effects: [
      { id: 'lib-plasma',     name: 'Plasma',        preview: 'linear-gradient(135deg,#74b,#5ad,#0d6,#9ff,#74b)',
        code: `const h = sin(x * 6 + t * 3) * 0.5 + sin(y * 5 - t * 2) * 0.5;\nreturn hsv(fract(h * 0.5 + 0.5), 0.9, 1);` },
      { id: 'lib-radial',     name: 'Radial Sweep',  preview: 'conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
        code: `const cx = x - 0.5, cy = y - 0.5;\nconst angle = (atan2(cy, cx) / TAU + 0.5 + time * 0.5) % 1;\nreturn hsv(angle, 1, 1);` },
      { id: 'lib-ripple',     name: 'Ripple',        preview: 'radial-gradient(circle,#fff,#00f,#000,#00f,#000)',
        code: `// @param freq float 8 2 20\nconst cx = x - 0.5, cy = y - 0.5;\nconst r  = sqrt(cx*cx + cy*cy);\nconst v  = sin(r * params.freq * TAU - t * 4) * 0.5 + 0.5;\nreturn hsv(0.6 + v * 0.1, 0.9, v);` },
      { id: 'lib-perlin-flow',name: 'Perlin Flow',   preview: 'linear-gradient(135deg,#406,#068,#040,#640)',
        code: `const n  = noise(x * 3 + t * 0.5, y * 3);\nconst n2 = noise(x * 3, y * 3 + t * 0.4);\nreturn hsv(fract(n + n2), 0.8, 0.5 + n * 0.5);` },
      { id: 'lib-wave-interference', name: 'Wave Interference', preview: 'radial-gradient(circle at 30% 30%,#fff,#00f,#000),radial-gradient(circle at 70% 70%,#fff,#f00,transparent)',
        code: `// @param freq float 10 3 30\n// @param cx1 float 0.3 0 1\n// @param cy1 float 0.3 0 1\nconst r1 = sqrt(pow(x-params.cx1,2)+pow(y-params.cy1,2));\nconst r2 = sqrt(pow(x-(1-params.cx1),2)+pow(y-(1-params.cy1),2));\nconst w1 = sin(r1*params.freq*TAU - t*3);\nconst w2 = sin(r2*params.freq*TAU - t*3);\nconst v = clamp((w1 + w2) * 0.5 + 0.5, 0, 1);\nreturn hsv(v * 0.66, 0.9, v);` },
      { id: 'lib-mandala', name: 'Mandala', preview: 'conic-gradient(#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)',
        code: `// @param folds int 6 2 16\n// @param spin float 0.2 0 2\nconst p = polar(x, y);\nconst fa = fract(p.a * params.folds) * 2;\nconst angle = fa < 1 ? fa : 2 - fa;\nconst v = sin(angle * TAU + t * params.spin) * 0.5 + 0.5;\nreturn hsv(fract(p.r * 2 + time), 0.9, v * clamp(1 - p.r * 1.5, 0, 1));` },
      { id: 'lib-contour', name: 'Contour Lines', preview: 'repeating-linear-gradient(135deg,#080 0%,#080 45%,#0f0 50%,#080 55%,#080 100%)',
        code: `// @param bands float 8 2 20\n// @param speed float 0.3 0 2\nconst n = fbm(x * 3, y * 3 + t * params.speed, 4);\nconst band = fract(n * params.bands);\nconst edge = smoothstep(0, 0.05, band) * smoothstep(1, 0.95, band);\nreturn hsv(0.35 + n * 0.2, 0.8, edge);` },
      { id: 'lib-voronoi', name: 'Voronoi Cells', preview: 'radial-gradient(circle at 20% 30%,#f06 0%,transparent 30%),radial-gradient(circle at 70% 60%,#06f 0%,transparent 30%),radial-gradient(circle at 50% 80%,#0f6 0%,transparent 30%),#111',
        code: `// @param seeds int 6 2 16\n// @param speed float 0.15 0 1\nlet minD = 1e9, minI = 0, secD = 1e9;\nfor (let i = 0; i < params.seeds; i++) {\n  const sx = noise(i * 3.1, t * params.speed);\n  const sy = noise(i * 5.7 + 0.5, t * params.speed + 0.3);\n  const d  = sqrt(pow(x-sx,2)+pow(y-sy,2));\n  if (d < minD) { secD = minD; minD = d; minI = i; } else if (d < secD) { secD = d; }\n}\nconst edge = smoothstep(0, 0.04, secD - minD);\nreturn hsv(randomF(minI * 7.3), 0.9, edge * (0.6 + minD * 0.5));` },
      { id: 'lib-fbm-flow', name: 'FBM Flow', preview: 'linear-gradient(135deg,#206,#048,#024,#604)',
        code: `// @param scale float 2 0.5 5\n// @param speed float 0.3 0.05 1\nconst n1 = fbm(x*params.scale + t*params.speed, y*params.scale, 5);\nconst n2 = fbm(x*params.scale, y*params.scale - t*params.speed*0.7, 5);\nreturn hsv(fract(n1 + n2 * 0.5), 0.85, 0.4 + n1 * 0.6);` },
    ],
  },
  {
    category: 'Ambient',
    effects: [
      { id: 'lib-twinkle',    name: 'Twinkle Stars', preview: 'radial-gradient(circle at 15% 80%,#acf 0%,transparent 5%),radial-gradient(circle at 55% 20%,#fed 0%,transparent 4%),radial-gradient(circle at 85% 60%,#cfe 0%,transparent 6%),#040412',
        code: `const ph = randomF(index * 3.7) * TAU;\nconst sp = 0.3 + randomF(index * 1.3) * 0.7;\nconst v  = pow(sin(t * sp + ph) * 0.5 + 0.5, 3);\nreturn hsv(0.55 + randomF(index * 7) * 0.15, 0.3, v);` },
      { id: 'lib-candle',     name: 'Candle',        preview: 'linear-gradient(0deg,#200,#600,#c40,#f80,#ffc)',
        code: `const flicker = noise(index * 0.3 + t * 3, t * 2) * 0.4 + 0.6;\nconst wave    = sin(index * 0.8 + t * 2) * 0.1 + 0.9;\nconst v       = clamp(flicker * wave, 0, 1);\nreturn hsv(lerp(0.02, 0.08, v), 1, v);` },
      { id: 'lib-firefly',    name: 'Firefly',       preview: 'radial-gradient(circle at 30% 60%,#ff0 0%,transparent 8%),radial-gradient(circle at 70% 40%,#8f0 0%,transparent 6%),#000',
        code: `// @param count int 5 1 20\nlet r = 0, g = 0, b = 0;\nfor (let i = 0; i < params.count; i++) {\n  const px = noise(i * 1.7 + 0.1, t * 0.3);\n  const py = noise(i * 2.3 + 0.5, t * 0.25);\n  const dist = sqrt(pow(x - px, 2) + pow(y - py, 2));\n  const v = clamp(1 - dist * 15, 0, 1);\n  const bright = (sin(t * (0.5 + i * 0.1) * TAU) * 0.5 + 0.5);\n  r += v * bright * 220; g += v * bright * 255; b += v * bright * 80;\n}\nreturn { r: min(r,255), g: min(g,255), b: min(b,255) };` },
      { id: 'lib-northern-lights', name: 'Northern Lights', preview: 'linear-gradient(180deg,#000,#013,#0a4,#3df,#60f,#000)',
        code: `const wave = sin(x * 3 + t * 0.2) * 0.3 + sin(x * 5 - t * 0.15) * 0.2;\nconst band = clamp(1 - abs(y - 0.5 - wave) * 4, 0, 1);\nconst h = 0.4 + x * 0.25 + noise(x * 2, t * 0.1) * 0.1;\nreturn hsv(h, 0.9, band * (0.5 + noise(x * 4 + t, t * 0.3) * 0.5));` },
    ],
  },
  {
    category: 'Strip-Aware',
    effects: [
      { id: 'lib-strip-identity', name: 'Strip Identity', preview: 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f)',
        code: `// Each strip gets its own hue; stripProgress drives brightness\nconst hue = fract(randomF(stripId.length ? stripId.charCodeAt(0) * 0.01 + stripId.length * 0.07 : 0));\nreturn hsv(hue, 1, wave(stripProgress - time));` },
      { id: 'lib-strip-chase', name: 'Per-Strip Chase', preview: 'linear-gradient(90deg,#000,#fff,#000)',
        code: `// Chase runs independently on each strip (not global index)\n// @param dotSize float 0.05 0.01 0.3\nconst pos = fract(time);\nconst d0 = abs(stripProgress - pos);\nconst dist = min(d0, 1-d0);\nreturn hsv(fract(time*0.5), 1, clamp(1 - dist/params.dotSize, 0, 1));` },
      { id: 'lib-strip-ripple', name: 'Strip Ripple', preview: 'linear-gradient(90deg,#004,#00f,#4af,#fff,#4af,#00f,#004)',
        code: `// Ripple from the center of each strip outward\n// @param freq float 6 1 20\nconst center = 0.5;\nconst dist = abs(stripProgress - center);\nconst v = sin(dist * params.freq * TAU - t * 3) * 0.5 + 0.5;\nreturn hsv(0.6 + v * 0.15, 0.9, v * (1 - dist));` },
      { id: 'lib-strip-alternate', name: 'Strip Alternate', preview: 'linear-gradient(90deg,#f60,#f60,#06f,#06f)',
        code: `// Alternate patterns on odd/even strips based on stripId hash\nconst odd = (stripId.charCodeAt ? stripId.charCodeAt(0) : 0) % 2;\nconst v = wave(stripProgress + time * (odd ? 1 : -1));\nreturn hsv(odd ? 0.08 : 0.6, 0.9, v);` },
    ],
  },
];

let _libraryCatFilter = '';

function _renderEffectLibrary() {
  const list = document.getElementById('library-list');
  const cats = document.getElementById('library-cats');
  if (!list) return;

  // Category filter pills
  if (cats) {
    cats.innerHTML = '';
    const allBtn = document.createElement('button');
    allBtn.className = 'lib-cat-btn' + (!_libraryCatFilter ? ' active' : '');
    allBtn.textContent = 'All';
    allBtn.addEventListener('click', () => { _libraryCatFilter = ''; _renderEffectLibrary(); });
    cats.appendChild(allBtn);
    EFFECT_LIBRARY.forEach(({ category }) => {
      const b = document.createElement('button');
      b.className = 'lib-cat-btn' + (_libraryCatFilter === category ? ' active' : '');
      b.textContent = category;
      b.addEventListener('click', () => { _libraryCatFilter = category; _renderEffectLibrary(); });
      cats.appendChild(b);
    });
  }

  list.innerHTML = '';
  const visible = _libraryCatFilter
    ? EFFECT_LIBRARY.filter(g => g.category === _libraryCatFilter)
    : EFFECT_LIBRARY;

  visible.forEach(({ category, effects }) => {
    const hdr = document.createElement('div');
    hdr.className = 'lib-category';
    hdr.textContent = category;
    list.appendChild(hdr);
    effects.forEach(eff => {
      const row = document.createElement('button');
      row.className = 'lib-effect-row';
      row.title = eff.name;
      row.innerHTML =
        `<span class="lib-preview" style="background:${eff.preview}"></span>` +
        `<span class="lib-name">${eff.name}</span>`;
      row.addEventListener('click', () => {
        // Copy effect into user patterns if not already there, then activate
        let pat = state.patterns.find(p => p.id === eff.id);
        if (!pat) {
          pat = { id: eff.id, name: eff.name, desc: eff.name, preview: eff.preview, code: eff.code };
          state.patterns.push(pat);
        } else {
          pat.code = eff.code; // update in case library changed
        }
        state.activePatternId = eff.id;
        _loadPatternIntoEditor();
        renderPatternCards();
        // Close library
        document.getElementById('effect-library')?.classList.add('hidden');
        document.getElementById('btn-show-library')?.classList.remove('active');
        // Switch to pattern tab
        _switchTab('pattern');
        showToast(`"${eff.name}" loaded — hit Play to run it.`);
      });
      list.appendChild(row);
    });
  });
}

// ── Canvas Manager ────────────────────────────────────────────────────────

const canvasManager = new CanvasManager(svgEl, {
  getPitch:   _getPitch,
  getPxPerMm: _getPxPerMm,

  onStripCreated(strip) {
    _pushHistory();
    _markDirty();
    const pathEl = canvasManager.getPathEl(strip.id);
    if (strip.svgLength == null && pathEl) strip.svgLength = pathEl.getTotalLength();
    strip.pixels     = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
    strip.visible    = strip.visible    ?? true;
    strip.speed      = strip.speed      ?? 1.0;
    strip.brightness = strip.brightness ?? 1.0;  // A1
    strip.hueShift   = strip.hueShift   ?? 0;    // A3
    strip.reversed   = strip.reversed   ?? false; // A4
    strip.patternId  = strip.patternId  ?? null;  // C1
    if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    state.stripTimes.set(strip.id, { t: 0, time: 0 });
    state.strips.push(strip);
    _reindex();
    _rebuildNorm();
    renderStripsList();
    syncExportInfo();
    _updateEmptyState();
    canvasManager.setStripDots(strip.id, strip.pixels);
  },

  onStripSelected(id) {
    // Update sidebar selection highlight
    document.querySelectorAll('#strips-list li').forEach(li => {
      li.classList.toggle('selected',      li.dataset.id === id);
      li.classList.toggle('layer-active',  li.dataset.id === id);
    });
    if (id) {
      const strip = state.strips.find(s => s.id === id);
      if (strip) _showStripPopup(strip);
    } else {
      _hideStripPopup();
    }
  },

  onStripDeleted(id) {
    _pushHistory();
    _markDirty();
    state.strips = state.strips.filter(s => s.id !== id);
    state.stripTimes.delete(id);
    // C3: remove from any group (handles canvas-tool deletes too)
    for (const g of state.groups) g.stripIds = g.stripIds.filter(sid => sid !== id);
    _reindex();
    _rebuildNorm();
    renderStripsList();
    syncExportInfo();
    _updateEmptyState();
  },

  onImportRequest(layers) {
    state.artworkLayers = layers;
    state.layerGroups   = [];
    state.panelChecked  = new Set();
    // Build display order from SVG layer order
    state.layerOrder = layers.map(l => ({ type: 'layer', id: l.layerId }));
    // Pre-assign palette colors, and restore persisted hidden/color state from project
    layers.forEach(l => {
      l._expanded = true; // expanded by default
      const saved = state.artworkLayerState.find(s => s.layerId === l.layerId);
      l._color  = saved?._color  ?? l._color ?? canvasManager.nextColor();
      l._hidden = saved?._hidden ?? false;
      if (l._hidden) canvasManager.setArtworkLayerVisible(l.layerId, false);
    });
    canvasManager.setLayerHitPaths(layers);
    renderArtworkLayersList();
    _switchTab('strips');
    if (layers.length) {
      showToast(`${layers.length} layer${layers.length !== 1 ? 's' : ''} imported — click a layer in the sidebar or canvas to configure`, 'ok');
    } else {
      showToast('No layers found in this SVG — try exporting with layers from Illustrator.', 'warn');
    }
  },

  onError(msg) {
    showToast(msg, 'warn');
  },

  onPrompt(msg, defaultVal) {
    return showPrompt(msg, defaultVal);
  },

  onLayerClick(layerId) {
    const layer = state.artworkLayers.find(l => l.layerId === layerId);
    if (layer) {
      _showInspector(layer);
    } else {
      showToast('No path data found for this layer.', 'warn');
    }
  },

  onPathSelectionChange(selections) {
    state.pathSelection = selections;
    _renderPathSelectionPanel();
    _hideInspector();
    _switchTab('strips');
  },

  onConnectionRequest(fromId, toId) {
    _pushHistory();
    state.connections = state.connections.filter(c => c.fromId !== fromId && c.toId !== toId);
    state.connections.push({ fromId, toId });
    _buildChainMap();
    _rebuildNorm();
    canvasManager.renderConnections(state.connections);
    showToast(`Connected — pattern will flow from one section into the next.`);
  },

  onStripMoved(id, dx, dy) {
    _pushHistory();
    const strip = state.strips.find(s => s.id === id);
    if (!strip) return;
    strip.offsetX = (strip.offsetX || 0) + dx;
    strip.offsetY = (strip.offsetY || 0) + dy;
    strip.pixels.forEach(px => { px.x += dx; px.y += dy; });
    _reindex();
    _rebuildNorm();
    canvasManager.setStripDots(id, strip.pixels);
  },
});

const previewRenderer = new PreviewRenderer(wrapper);

function _buildChainMap() {
  const next = new Map(); // fromId → toId
  const prev = new Map(); // toId   → fromId
  for (const { fromId, toId } of state.connections) {
    next.set(fromId, toId);
    prev.set(toId,   fromId);
  }

  state.chainById = new Map();

  // Find roots: strips with outgoing connections but no incoming
  const allFromIds = new Set(state.connections.map(c => c.fromId));
  for (const rootId of allFromIds) {
    if (prev.has(rootId)) continue; // not a root
    if (!state.strips.find(s => s.id === rootId)) continue;

    // Walk chain from root
    const chain = [];
    let cur = rootId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = next.get(cur);
    }

    // Compute per-strip offsets and chain total
    let offset = 0;
    for (const sid of chain) {
      const strip = state.strips.find(s => s.id === sid);
      state.chainById.set(sid, { chainId: rootId, offset, total: 0 });
      offset += strip?.pixelCount ?? 0;
    }
    const total = offset;
    for (const sid of chain) state.chainById.get(sid).total = total;
  }
}

function _reindex() {
  assignIndices(state.strips);
  _buildChainMap();
}

// ── Empty state ────────────────────────────────────────────────────────────

const _hasArtwork = () => (document.querySelector('#imported-svg')?.childElementCount ?? 0) > 0;

function _updateEmptyState() {
  const el = document.getElementById('canvas-empty');
  if (!el) return;
  el.classList.toggle('hidden', state.strips.length > 0 || _hasArtwork());
}

// ── Quick-start shape templates ────────────────────────────────────────────

function _createQuickStrip(name, pathData, pixelCount, color) {
  _pushHistory();
  const strip = {
    id:         crypto.randomUUID(),
    name,
    pathData,
    pixelCount,
    color:      color ?? canvasManager.nextColor(),
    visible:    true,
    speed:      1.0,
    brightness: 1.0,
    hueShift:   0,
    reversed:   false,
    patternId:  null,
  };
  canvasManager.addStrip(strip);
  const pathEl = canvasManager.getPathEl(strip.id);
  strip.svgLength = pathEl?.getTotalLength() ?? 0;
  strip.pixels    = pathEl ? samplePath(pathEl, pixelCount) : [];
  state.strips.push(strip);
  state.stripTimes.set(strip.id, { t: 0, time: 0 });
  canvasManager.setStripDots(strip.id, strip.pixels);
  _reindex(); _rebuildNorm();
  renderStripsList(); syncExportInfo(); _updateEmptyState();
  return strip;
}

function _spiralPathData(w, h, turns, n) {
  const cx = w / 2, cy = h / 2;
  const maxR = Math.min(w, h) * 0.38;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t     = i / n;
    const angle = t * turns * Math.PI * 2;
    const r     = maxR * t;
    pts.push(`${(cx + Math.cos(angle) * r).toFixed(1)},${(cy + Math.sin(angle) * r).toFixed(1)}`);
  }
  return 'M ' + pts.join(' L ');
}

function _startShapeTemplate(shape) {
  const leds = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('empty-leds'))?.value ?? '144', 10);
  const vb   = svgEl.viewBox.baseVal;
  const w    = vb.width  || 800;
  const h    = vb.height || 600;
  const cx   = w / 2, cy = h / 2;

  if (shape === 'strip') {
    _createQuickStrip('Strip',
      `M ${(w*0.1).toFixed(1)} ${cy.toFixed(1)} L ${(w*0.9).toFixed(1)} ${cy.toFixed(1)}`,
      leds);

  } else if (shape === 'circle') {
    const r  = Math.min(w, h) * 0.35;
    const x1 = (cx + r).toFixed(1), x2 = (cx - r).toFixed(1), rs = r.toFixed(1);
    _createQuickStrip('Circle',
      `M ${x1} ${cy.toFixed(1)} A ${rs} ${rs} 0 1 1 ${x2} ${cy.toFixed(1)} A ${rs} ${rs} 0 1 1 ${x1} ${cy.toFixed(1)}`,
      leds);

  } else if (shape === 'grid') {
    const rows   = 4;
    const colors = ['#ff6b6b', '#ffd166', '#06d6a0', '#118ab2'];
    for (let r = 0; r < rows; r++) {
      const y   = h * (0.2 + 0.6 * (r / (rows - 1)));
      const fwd = r % 2 === 0;
      const x0  = fwd ? w * 0.1 : w * 0.9;
      const x1  = fwd ? w * 0.9 : w * 0.1;
      _createQuickStrip(`Row ${r + 1}`,
        `M ${x0.toFixed(1)} ${y.toFixed(1)} L ${x1.toFixed(1)} ${y.toFixed(1)}`,
        Math.max(1, Math.round(leds / rows)),
        colors[r]);
    }

  } else if (shape === 'rings') {
    const radii  = [0.14, 0.24, 0.35].map(f => Math.min(w, h) * f);
    const colors = ['#ff6b6b', '#06d6a0', '#118ab2'];
    radii.forEach((r, i) => {
      const x1 = (cx + r).toFixed(1), x2 = (cx - r).toFixed(1), rs = r.toFixed(1);
      _createQuickStrip(`Ring ${i + 1}`,
        `M ${x1} ${cy.toFixed(1)} A ${rs} ${rs} 0 1 1 ${x2} ${cy.toFixed(1)} A ${rs} ${rs} 0 1 1 ${x1} ${cy.toFixed(1)}`,
        Math.max(1, Math.round(leds / radii.length)),
        colors[i]);
    });

  } else if (shape === 'spiral') {
    _createQuickStrip('Spiral', _spiralPathData(w, h, 3, 120), leds);
  }
  // onStripCreated handles _reindex/_rebuildNorm/renderStripsList/syncExportInfo/_updateEmptyState
  // for each strip; no duplicate calls needed here.
}

// ── File import (shared by button + drag-drop) ─────────────────────────────

async function _handleFileImport(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== 'svg') {
    showToast(`.${ext} files are not supported. Export your artwork as SVG from Illustrator: File → Export As → SVG.`, 'warn');
    return;
  }
  const text = await file.text();
  if (!text.includes('<svg') && !text.includes('<SVG')) {
    showToast('This file does not appear to be a valid SVG. In Illustrator use File → Export As → SVG (not Save As).', 'warn');
    return;
  }
  state._svgSource = text;
  canvasManager.importSVG(text, true);
  // Sync preview renderer coordinate space with the SVG viewBox
  const vb = svgEl.viewBox.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) {
    previewRenderer.setViewBox(vb.x, vb.y, vb.width, vb.height);
  } else {
    previewRenderer.setViewBox(0, 0, 0, 0);
  }
  _updateEmptyState();
}

function _rebuildNorm() {
  const visibleStrips = state.strips.filter(s => s.visible !== false);

  if (!visibleStrips.length) {
    state.normalisedPixels = [];
    previewRenderer.init([]);
    return;
  }

  // Compute global bounding box across all visible strips
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const strip of visibleStrips) {
    for (const p of strip.pixels) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
  }
  const range = Math.max(maxX - minX, maxY - minY) || 1;

  // Flatten, normalize, and stamp each pixel with its strip ID so the
  // render loop can look up per-strip speed and accumulated time.
  state.normalisedPixels = [];
  for (const strip of visibleStrips) {
    const chainInfo = state.chainById.get(strip.id);
    strip.pixels.forEach((px, localIdx) => {
      const chainIndex  = chainInfo ? chainInfo.offset + localIdx : px.index;
      const chainTotal  = chainInfo ? chainInfo.total              : strip.pixelCount;
      const chainRootId = chainInfo ? chainInfo.chainId            : strip.id;
      state.normalisedPixels.push({
        ...px,
        nx: (px.x - minX) / range,
        ny: (px.y - minY) / range,
        stripId:     strip.id,
        stripIndex:  localIdx,
        stripTotal:  strip.pixelCount,
        chainIndex,
        chainTotal,
        chainRootId,
      });
    });
  }

  previewRenderer.init(state.normalisedPixels);
  if (previewRenderer._coverageColorMap) {
    previewRenderer.showCoverage(_coverageColorMap(), _coverageAngleMap());
  }
  if (state.normalisedPixels.length && !state.animating) {
    setTimeout(() => { if (!state.animating) _compileAndRun(); }, 0);
  }
}

// ── Pattern compile ───────────────────────────────────────────────────────

let _recompileTimer = null;

function _scheduleRecompile() {
  clearTimeout(_recompileTimer);
  _recompileTimer = setTimeout(() => {
    _saveEditorToPattern();
    renderParamSliders(); // B4: re-parse @params after edit
    if (!state.animating) return;
    const p = _activePattern();
    if (!p) return;
    const { fn, error } = compile(p.code);
    _showError(error);
    if (fn) state.compiledFns.set(p.id, fn);
  }, 500);
}

function _compileAndRun() {
  _saveEditorToPattern();
  renderPatternSelect();
  renderParamSliders(); // B4: parse @params on run

  // C1: compile all patterns referenced by any strip or the global active pattern
  const neededIds = new Set([state.activePatternId]);
  for (const strip of state.strips) {
    if (strip.patternId) neededIds.add(strip.patternId);
  }
  for (const g of state.groups) {
    if (g.patternId) neededIds.add(g.patternId);
  }

  let hasError = false;
  for (const pid of neededIds) {
    const p = state.patterns.find(p => p.id === pid);
    if (!p) continue;
    const { fn, error } = compile(p.code);
    if (pid === state.activePatternId) _showError(error);
    if (error && pid === state.activePatternId) { hasError = true; }
    if (fn) state.compiledFns.set(pid, fn);
  }
  if (hasError) { stopAnim(); return; }
  startAnim();
}

function _showError(msg) {
  document.getElementById('pattern-error').textContent = msg ? `⚠ ${msg}` : '';
}

// ── Sections (strips) list ────────────────────────────────────────────────

function _buildStripLi(strip, from, to, extraClass) {
  const visible    = strip.visible !== false;
  const speed      = strip.speed ?? 1.0;
  const paused     = speed === 0;
  const mmStr      = strip.svgLength != null ? `${_fmtMm(_toMm(strip.svgLength))}mm` : '—';
  const brightness = strip.brightness ?? 1.0;
  const hueShift   = strip.hueShift   ?? 0;
  const reversed   = strip.reversed   ?? false;
  const dimRow     = brightness < 0.5;

  // C1: build pattern options
  const patternOpts = state.patterns.map(p =>
    `<option value="${p.id}"${strip.patternId === p.id ? ' selected' : ''}>${p.name}</option>`
  ).join('');

  const li = document.createElement('li');
  li.dataset.id = strip.id;
  li.style.setProperty('--strip-color', strip.color);
  if (!visible)   li.classList.add('strip-hidden');
  if (paused)     li.classList.add('strip-paused');
  if (dimRow)     li.classList.add('section-dim');
  if (extraClass) li.classList.add(extraClass);
  if (state.chainById.has(strip.id)) {
    const info = state.chainById.get(strip.id);
    li.classList.add(info.offset === 0 ? 'chain-root' : 'chain-member');
  }

  li.innerHTML = `
    <div class="strip-row-top">
      <label class="strip-color-wrap" title="Click to change color">
        <input type="color" class="strip-color-input" value="${strip.color}" aria-label="Strip color" />
        <span class="strip-swatch" style="background:${strip.color}"></span>
      </label>
      <button class="strip-vis-btn${visible ? '' : ' hidden-strip'}"
              aria-label="${visible ? 'Hide section' : 'Show section'}"
              title="${visible ? 'Hide section' : 'Show section'}">${visible ? '●' : '○'}</button>
      <span class="strip-name" title="${strip.name}">${strip.name}</span>
      <select class="strip-pattern-select" title="Pattern for this section">
        <option value="">Global</option>
        ${patternOpts}
      </select>
      <button class="btn-icon strip-duplicate" title="Duplicate section" aria-label="Duplicate section">⎘</button>
      <button class="btn-icon strip-delete" title="Delete section" aria-label="Delete section">×</button>
    </div>
    <div class="strip-row-bottom">
      <span class="strip-length" title="Path length">${mmStr}</span>
      <span class="strip-range">${from}–${to}</span>
      <input class="strip-pixel-input" type="number" value="${strip.pixelCount}"
             min="1" max="4096" title="LED count" />
      <span class="speed-label" title="Brightness">Br</span>
      <input class="strip-brightness-input" type="number"
             value="${brightness}" min="0" max="1" step="0.05"
             title="Section brightness — 0 = off, 1 = full" />
      <span class="speed-label" title="Hue shift (°)">Hue</span>
      <input class="strip-hue-input" type="number"
             value="${hueShift}" min="-180" max="180" step="1"
             title="Hue shift (degrees)" />
      <button class="strip-reverse-btn${reversed ? ' active' : ''}" title="Reverse pixel order">⇄</button>
      <span class="speed-label" title="Speed multiplier">×</span>
      <input class="strip-speed-input${paused ? ' speed-zero' : ''}${speed !== 1.0 ? ' speed-modified' : ''}" type="number"
             value="${speed}" min="0" max="8" step="0.05"
             title="Speed multiplier — 0 freezes this section" />
    </div>
  `;

  // C1: per-strip pattern select
  li.querySelector('.strip-pattern-select').addEventListener('change', e => {
    e.stopPropagation();
    _pushHistory();
    const v = /** @type {HTMLSelectElement} */ (e.target).value;
    strip.patternId = v || null;
    // Ensure the selected pattern is compiled
    if (strip.patternId) {
      const p = state.patterns.find(p => p.id === strip.patternId);
      if (p && !state.compiledFns.has(p.id)) {
        const { fn } = compile(p.code);
        if (fn) state.compiledFns.set(p.id, fn);
      }
    }
  });

  // Eye toggle
  li.querySelector('.strip-vis-btn').addEventListener('click', e => {
    e.stopPropagation();
    _pushHistory();
    const nowVisible = canvasManager.toggleStripVisible(strip.id);
    strip.visible = nowVisible;
    _rebuildNorm();
    renderStripsList();
  });

  // Pixel count change
  li.querySelector('.strip-pixel-input').addEventListener('change', e => {
    _pushHistory();
    const n = parseInt(/** @type {HTMLInputElement} */(e.target).value, 10);
    if (!n || n < 1) return;
    strip.pixelCount = n;
    const pathEl = canvasManager.getPathEl(strip.id);
    if (pathEl) {
      strip.pixels = samplePath(pathEl, n);
      if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    }
    _reindex(); _rebuildNorm();
    canvasManager.setStripDots(strip.id, strip.pixels);
    renderStripsList(); syncExportInfo();
  });

  // Brightness input (A1)
  li.querySelector('.strip-brightness-input').addEventListener('change', e => {
    e.stopPropagation();
    _pushHistory();
    const v = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
    strip.brightness = isNaN(v) ? 1.0 : Math.max(0, Math.min(1, v));
    /** @type {HTMLInputElement} */ (e.target).value = strip.brightness;
    li.classList.toggle('section-dim', strip.brightness < 0.5);
  });

  // Scroll wheel on brightness input (IMPROVEMENT 2)
  li.querySelector('.strip-brightness-input').addEventListener('focus', () => _pushHistory());
  li.querySelector('.strip-brightness-input').addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    const input = /** @type {HTMLInputElement} */ (e.target);
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    strip.brightness = Math.round(Math.max(0, Math.min(1, (strip.brightness ?? 1.0) + delta)) * 100) / 100;
    input.value = strip.brightness;
    li.classList.toggle('section-dim', strip.brightness < 0.5);
  }, { passive: false });

  // Hue shift input (A3)
  li.querySelector('.strip-hue-input').addEventListener('change', e => {
    e.stopPropagation();
    _pushHistory();
    const v = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
    strip.hueShift = isNaN(v) ? 0 : Math.max(-180, Math.min(180, v));
    /** @type {HTMLInputElement} */ (e.target).value = strip.hueShift;
  });

  // Scroll wheel on hue input (IMPROVEMENT 2)
  li.querySelector('.strip-hue-input').addEventListener('focus', () => _pushHistory());
  li.querySelector('.strip-hue-input').addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    const input = /** @type {HTMLInputElement} */ (e.target);
    const delta = e.deltaY < 0 ? 1 : -1;
    strip.hueShift = Math.max(-180, Math.min(180, (strip.hueShift ?? 0) + delta));
    input.value = strip.hueShift;
  }, { passive: false });

  // Reverse toggle (A4)
  li.querySelector('.strip-reverse-btn').addEventListener('click', e => {
    e.stopPropagation();
    strip.reversed = !strip.reversed;
    /** @type {HTMLButtonElement} */ (e.target).classList.toggle('active', strip.reversed);
    const pathEl = canvasManager.getPathEl(strip.id);
    if (pathEl) {
      strip.pixels = samplePath(pathEl, strip.pixelCount);
      if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    }
    _reindex(); _rebuildNorm();
    canvasManager.setStripDots(strip.id, strip.pixels);
    canvasManager.refreshStripArrow(strip.id);
  });

  // Speed input
  li.querySelector('.strip-speed-input').addEventListener('change', e => {
    e.stopPropagation();
    _pushHistory();
    const v = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
    strip.speed = isNaN(v) || v < 0 ? 0 : Math.min(v, 8);
    const input = /** @type {HTMLInputElement} */ (e.target);
    input.value = strip.speed;
    input.classList.toggle('speed-zero',     strip.speed === 0);
    input.classList.toggle('speed-modified', strip.speed !== 1.0); // BUG 5
    li.classList.toggle('strip-paused', strip.speed === 0);
  });

  // Scroll wheel on speed input for fine control without typing
  li.querySelector('.strip-speed-input').addEventListener('focus', () => _pushHistory());
  li.querySelector('.strip-speed-input').addEventListener('wheel', e => {
    e.preventDefault();
    e.stopPropagation();
    const input = /** @type {HTMLInputElement} */ (e.target);
    const delta = e.deltaY < 0 ? 0.05 : -0.05;
    const next  = Math.max(0, Math.min(8, (strip.speed ?? 1) + delta));
    strip.speed = Math.round(next * 100) / 100;
    input.value = strip.speed;
    input.classList.toggle('speed-zero',     strip.speed === 0);
    input.classList.toggle('speed-modified', strip.speed !== 1.0); // BUG 5
    li.classList.toggle('strip-paused', strip.speed === 0);
  }, { passive: false });

  // Color swatch — click label opens native color picker
  li.querySelector('.strip-color-wrap').addEventListener('click', () => {
    li.querySelector('.strip-color-input').click();
  });
  li.querySelector('.strip-color-input').addEventListener('focus', () => { _pushHistory(); }, { once: false });
  li.querySelector('.strip-color-input').addEventListener('input', e => {
    e.stopPropagation();
    const hex = /** @type {HTMLInputElement} */ (e.target).value;
    strip.color = hex;
    li.querySelector('.strip-swatch').style.background = hex;
    // Update SVG path color live
    const entry = canvasManager._strips?.get(strip.id);
    if (entry) {
      entry.pathEl.setAttribute('stroke', hex);
      entry.hitPath.setAttribute('stroke', hex);
    }
    _markDirty();
  });

  // Duplicate strip
  li.querySelector('.strip-duplicate').addEventListener('click', e => {
    e.stopPropagation();
    _pushHistory();
    const newStrip = {
      ...strip,
      id:      crypto.randomUUID(),
      name:    strip.name + ' copy',
      color:   canvasManager.nextColor(),
      offsetX: (strip.offsetX || 0) + 20,
      offsetY: (strip.offsetY || 0) + 20,
      pixels:  [],
    };
    canvasManager.addStrip(newStrip);
    const pathEl = canvasManager.getPathEl(newStrip.id);
    newStrip.svgLength = pathEl?.getTotalLength() ?? strip.svgLength;
    newStrip.pixels    = pathEl ? samplePath(pathEl, newStrip.pixelCount) : [];
    if (newStrip.offsetX || newStrip.offsetY) {
      const ox = newStrip.offsetX || 0, oy = newStrip.offsetY || 0;
      newStrip.pixels.forEach(px => { px.x += ox; px.y += oy; });
    }
    state.strips.push(newStrip);
    state.stripTimes.set(newStrip.id, { t: 0, time: 0 });
    canvasManager.setStripDots(newStrip.id, newStrip.pixels);
    _reindex(); _rebuildNorm();
    renderStripsList(); syncExportInfo(); _updateEmptyState();
    _markDirty();
  });

  // Delete
  li.querySelector('.strip-delete').addEventListener('click', e => {
    e.stopPropagation();
    // Remove from any group
    for (const g of state.groups) {
      g.stripIds = g.stripIds.filter(sid => sid !== strip.id);
    }
    canvasManager.deleteStrip(strip.id);
  });

  // Click row → select strip (shift-click → multi-select)
  li.addEventListener('click', e => {
    if (e.shiftKey) {
      if (state.selectedIds.has(strip.id)) {
        state.selectedIds.delete(strip.id);
        li.classList.remove('multi-selected');
      } else {
        state.selectedIds.add(strip.id);
        li.classList.add('multi-selected');
      }
      _updateMultiSelectBar();
    } else {
      state.selectedIds.clear();
      document.querySelectorAll('#strips-list li.multi-selected').forEach(el => el.classList.remove('multi-selected'));
      _updateMultiSelectBar();
      canvasManager.selectStrip(strip.id);
    }
  });

  // Feature 8: Double-click → inline rename
  li.addEventListener('dblclick', e => {
    e.stopPropagation();
    const nameSpan = li.querySelector('.strip-name');
    if (!nameSpan || li.querySelector('.strip-name-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'strip-name-input';
    input.value = strip.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const val = input.value.trim();
      if (val) strip.name = val;
      const span = document.createElement('span');
      span.className = 'strip-name';
      span.title = strip.name;
      span.textContent = strip.name;
      input.replaceWith(span);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e2 => {
      if (e2.key === 'Enter')  { commit(); e2.preventDefault(); }
      if (e2.key === 'Escape') { input.value = strip.name; commit(); }
      e2.stopPropagation();
    });
  });

  return li;
}

function renderStripsList() {
  const list  = document.getElementById('strips-list');
  // PERF 3: preserve scroll position across re-renders
  const prevScrollTop = list.scrollTop;
  const total = state.strips.reduce((n, s) => n + s.pixelCount, 0);
  document.getElementById('strip-count').textContent = state.strips.length;
  document.getElementById('total-leds').textContent  = total;
  document.getElementById('status-leds').textContent = total ? `${total} LEDs` : '';

  const searchQ = (/** @type {HTMLInputElement|null} */ (document.getElementById('strips-search'))?.value ?? '').toLowerCase().trim();

  list.innerHTML = '';

  // Build index offset map
  let globalIdx = 0;
  const stripFromIdx = new Map();
  for (const strip of state.strips) {
    stripFromIdx.set(strip.id, globalIdx);
    globalIdx += strip.pixelCount;
  }

  // C3: track which strips are in a group
  const groupedStripIds = new Set();
  for (const g of state.groups) {
    for (const sid of g.stripIds) groupedStripIds.add(sid);
  }

  // Render groups first
  for (const group of state.groups) {
    // Feature 9: default color for groups loaded from project files
    if (!group.color) group.color = '#555';

    const groupLi = document.createElement('li');
    groupLi.className = 'group-header';
    groupLi.dataset.groupId = group.id;

    const vis   = group.visible !== false;
    const speed = group.speed != null ? group.speed : '';
    const bright= group.brightness != null ? group.brightness : '';
    const hue   = group.hueShift  != null ? group.hueShift  : '';

    // C1: pattern options for group
    const patOpts = state.patterns.map(p =>
      `<option value="${p.id}"${group.patternId === p.id ? ' selected' : ''}>${p.name}</option>`
    ).join('');

    groupLi.innerHTML = `
      <input type="color" class="group-color-swatch" value="${group.color || '#06d6a0'}" title="Group colour" />
      <button class="group-collapse-btn" title="Expand/collapse">${group.collapsed ? '▶' : '▼'}</button>
      <button class="group-vis-btn" title="${vis ? 'Hide group' : 'Show group'}">${vis ? '●' : '○'}</button>
      <span class="group-name">${group.name}</span>
      <select class="group-pattern-select" title="Pattern override for group">
        <option value="">—</option>
        ${patOpts}
      </select>
      <span class="speed-label" title="Group brightness override">Br</span>
      <input class="group-brightness-input" type="number" value="${bright}" min="0" max="1" step="0.05"
             placeholder="—" title="Group brightness (overrides strips)" style="width:40px" />
      <span class="speed-label" title="Group hue shift override">Hue</span>
      <input class="group-hue-input" type="number" value="${hue}" min="-180" max="180" step="1"
             placeholder="—" title="Group hue shift (overrides strips)" style="width:44px" />
      <span class="speed-label" title="Group speed override">×</span>
      <input class="group-speed-input" type="number" value="${speed}" min="0" max="8" step="0.05"
             placeholder="—" title="Group speed (overrides strips)" style="width:40px" />
      <button class="group-assign-btn" title="Assign strips to group">Assign…</button>
      <button class="btn-icon group-delete-btn" title="Delete group">×</button>
    `;

    // Feature 9: group color swatch change listener
    groupLi.querySelector('.group-color-swatch')?.addEventListener('input', e => {
      e.stopPropagation();
      group.color = e.target.value;
    });

    // Collapse toggle
    groupLi.querySelector('.group-collapse-btn').addEventListener('click', e => {
      e.stopPropagation();
      group.collapsed = !group.collapsed;
      renderStripsList();
    });

    // Group visibility
    groupLi.querySelector('.group-vis-btn').addEventListener('click', e => {
      e.stopPropagation();
      group.visible = !(group.visible !== false);
      for (const sid of group.stripIds) {
        const strip = state.strips.find(s => s.id === sid);
        if (!strip) continue;
        const isNowVisible = group.visible;
        if (strip.visible !== isNowVisible) {
          canvasManager.toggleStripVisible(sid);
          strip.visible = isNowVisible;
        }
      }
      _rebuildNorm();
      renderStripsList();
    });

    // Group pattern
    groupLi.querySelector('.group-pattern-select').addEventListener('change', e => {
      e.stopPropagation();
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      group.patternId = v || null;
      if (group.patternId) {
        const p = state.patterns.find(p => p.id === group.patternId);
        if (p && !state.compiledFns.has(p.id)) {
          const { fn } = compile(p.code);
          if (fn) state.compiledFns.set(p.id, fn);
        }
      }
    });

    // Group brightness
    groupLi.querySelector('.group-brightness-input').addEventListener('change', e => {
      e.stopPropagation();
      const raw = /** @type {HTMLInputElement} */ (e.target).value.trim();
      group.brightness = raw === '' ? null : Math.max(0, Math.min(1, parseFloat(raw)));
    });

    // Group hue
    groupLi.querySelector('.group-hue-input').addEventListener('change', e => {
      e.stopPropagation();
      const raw = /** @type {HTMLInputElement} */ (e.target).value.trim();
      group.hueShift = raw === '' ? null : Math.max(-180, Math.min(180, parseFloat(raw)));
    });

    // Group speed
    groupLi.querySelector('.group-speed-input').addEventListener('change', e => {
      e.stopPropagation();
      const raw = /** @type {HTMLInputElement} */ (e.target).value.trim();
      group.speed = raw === '' ? null : Math.max(0, Math.min(8, parseFloat(raw)));
    });

    // Assign strips
    groupLi.querySelector('.group-assign-btn').addEventListener('click', e => {
      e.stopPropagation();
      _showAssignPanel(group, groupLi.querySelector('.group-assign-btn'));
    });

    // Delete group
    groupLi.querySelector('.group-delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      state.groups = state.groups.filter(g => g.id !== group.id);
      renderStripsList();
    });

    list.appendChild(groupLi);

    // Render member strips (indented) when not collapsed
    if (!group.collapsed) {
      for (const sid of group.stripIds) {
        const strip = state.strips.find(s => s.id === sid);
        if (!strip) continue;
        const from = stripFromIdx.get(strip.id) ?? 0;
        const to   = from + strip.pixelCount - 1;
        const memberLi = _buildStripLi(strip, from, to, 'group-member');
        list.appendChild(memberLi);
      }
    }
  }

  // Render ungrouped strips (filtered by search query)
  for (const strip of state.strips) {
    if (groupedStripIds.has(strip.id)) continue;
    if (searchQ && !strip.name.toLowerCase().includes(searchQ)) continue;
    const from = stripFromIdx.get(strip.id) ?? 0;
    const to   = from + strip.pixelCount - 1;
    list.appendChild(_buildStripLi(strip, from, to, null));
  }

  // PERF 3: restore scroll position
  list.scrollTop = prevScrollTop;
}

// ── C3: Assign panel ──────────────────────────────────────────────────────

let _assignPanelEl = null;
let _assignPanelGroup = null;

function _showAssignPanel(group, anchorEl) {
  _closeAssignPanel();
  _assignPanelGroup = group;

  const panel = document.createElement('div');
  panel.className = 'assign-panel';

  const rect = anchorEl.getBoundingClientRect();
  panel.style.top  = `${rect.bottom + 4}px`;
  panel.style.left = `${rect.left}px`;

  const header = document.createElement('div');
  header.className = 'assign-panel-header';
  header.textContent = `Assign strips to "${group.name}"`;
  panel.appendChild(header);

  for (const strip of state.strips) {
    const row = document.createElement('label');
    row.className = 'assign-row';
    const checked = group.stripIds.includes(strip.id);
    row.innerHTML = `
      <input type="checkbox" ${checked ? 'checked' : ''} />
      <span class="assign-swatch" style="background:${strip.color}"></span>
      <span>${strip.name}</span>
    `;
    row.querySelector('input').addEventListener('change', e => {
      if (/** @type {HTMLInputElement} */ (e.target).checked) {
        // Remove from any other group first
        for (const g of state.groups) {
          if (g.id !== group.id) g.stripIds = g.stripIds.filter(id => id !== strip.id);
        }
        if (!group.stripIds.includes(strip.id)) group.stripIds.push(strip.id);
      } else {
        group.stripIds = group.stripIds.filter(id => id !== strip.id);
      }
      renderStripsList();
    });
    panel.appendChild(row);
  }

  document.body.appendChild(panel);
  _assignPanelEl = panel;

  setTimeout(() => {
    document.addEventListener('click', _assignPanelOutside);
    document.addEventListener('keydown', _assignPanelEsc);
  }, 0);
}

function _assignPanelOutside(e) {
  if (_assignPanelEl && !_assignPanelEl.contains(/** @type {Node} */ (e.target))) {
    _closeAssignPanel();
  }
}

function _assignPanelEsc(e) {
  if (e.key === 'Escape') _closeAssignPanel();
}

function _closeAssignPanel() {
  if (_assignPanelEl) {
    _assignPanelEl.remove();
    _assignPanelEl = null;
    _assignPanelGroup = null;
  }
  document.removeEventListener('click', _assignPanelOutside);
  document.removeEventListener('keydown', _assignPanelEsc);
}

// ── Pattern UI ────────────────────────────────────────────────────────────

function renderPatternSelect() {
  const sel = document.getElementById('pattern-select');
  sel.innerHTML = '';
  state.patterns.forEach(p => {
    const opt = Object.assign(document.createElement('option'), {
      value: p.id, textContent: p.name, selected: p.id === state.activePatternId,
    });
    sel.appendChild(opt);
  });
  _loadPatternIntoEditor();
}

function renderPatternCards() {
  const container = document.getElementById('pattern-cards');
  if (!container) return;
  container.innerHTML = '';

  state.patterns.forEach(p => {
    const isActive = p.id === state.activePatternId;
    const btn = document.createElement('button');
    btn.className = 'pattern-card' + (isActive ? ' active' : '');
    btn.dataset.id = p.id;

    const preview = p.preview ?? 'linear-gradient(90deg,#222,#444)';
    btn.innerHTML =
      `<div class="pc-preview" style="background:${preview}"></div>` +
      `<div class="pc-body">` +
        `<div class="pc-name">${p.name}</div>` +
        `<div class="pc-desc">${p.desc ?? ''}</div>` +
      `</div>`;

    btn.addEventListener('click', () => {
      state.activePatternId = p.id;
      // Stale frozen frame from previous pattern — clear it
      previewRenderer._frozenColorFn = null;
      if (!state.animating) previewRenderer.renderStatic();
      // Sync the hidden dropdown
      const sel = document.getElementById('pattern-select');
      if (sel) sel.value = p.id;
      // Sync editor
      const nameEl = document.getElementById('pattern-name');
      if (nameEl) nameEl.value = p.name;
      _setEditorCode(p.code);
      renderParamSliders();
      renderPatternCards(); // re-render to update active state
      // Auto-compile if already running
      if (state.animating) {
        const { fn, error } = compile(p.code);
        _showError(error);
        if (fn) state.compiledFns.set(p.id, fn);
      }
    });

    container.appendChild(btn);
  });

  // "Load from file" card
  const loadBtn = document.createElement('button');
  loadBtn.className = 'pattern-card pattern-card-load';
  loadBtn.innerHTML =
    `<div class="pc-preview" style="background:#111;display:flex;align-items:center;justify-content:center;font-size:22px;color:#444">↑</div>` +
    `<div class="pc-body">` +
      `<div class="pc-name">Load effect file</div>` +
      `<div class="pc-desc">Import a .led-pattern.json</div>` +
    `</div>`;
  loadBtn.addEventListener('click', () => {
    document.getElementById('btn-import-pattern')?.click();
  });
  container.appendChild(loadBtn);
}

function _loadPatternIntoEditor() {
  const p = _activePattern();
  if (!p) return;
  /** @type {HTMLInputElement} */ (document.getElementById('pattern-name')).value = p.name;
  _setEditorCode(p.code);
  _showError(null);
  renderParamSliders(); // B4: update sliders when pattern changes
}

function _saveEditorToPattern() {
  const p = _activePattern();
  if (!p) return;
  const nameEl = /** @type {HTMLInputElement} */ (document.getElementById('pattern-name'));
  p.name = nameEl.value || p.name;
  p.code = _editorCode();
}

const _activePattern = () => state.patterns.find(p => p.id === state.activePatternId) ?? null;

// ── Color utilities (A3) ──────────────────────────────────────────────────

/** r,g,b 0–255 → { h, s, v } each 0–1 */
function _rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r)      h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** h,s,v each 0–1 → { r, g, b } 0–255 */
function _hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), tt = v * (1 - (1 - f) * s);
  const [rv, gv, bv] = [[v,tt,p],[q,v,p],[p,v,tt],[p,q,v],[tt,p,v],[v,p,q]][i % 6];
  return { r: Math.round(rv * 255), g: Math.round(gv * 255), b: Math.round(bv * 255) };
}

/** Apply hue shift (degrees, -180..180) to an RGB triplet (0–255 each). */
function _applyHueShift(r, g, b, hueShift) {
  const { h, s, v } = _rgbToHsv(r, g, b);
  return _hsvToRgb(h + hueShift / 360, s, v);
}

/** PERF 1: Precompute a 9-element RGB rotation matrix for a hue shift in degrees. */
function _hueRotateMatrix(deg) {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const k = 1/3, sq = Math.sqrt(1/3);
  return [
    c+(1-c)*k,     (1-c)*k-sq*s,  (1-c)*k+sq*s,
    (1-c)*k+sq*s,  c+(1-c)*k,     (1-c)*k-sq*s,
    (1-c)*k-sq*s,  (1-c)*k+sq*s,  c+(1-c)*k,
  ];
}

/** PERF 1: Apply a precomputed hue matrix to r,g,b (0-255). */
function _applyHueMatrix(r, g, b, m) {
  return {
    r: Math.max(0, Math.min(255, Math.round(r*m[0] + g*m[1] + b*m[2]))),
    g: Math.max(0, Math.min(255, Math.round(r*m[3] + g*m[4] + b*m[5]))),
    b: Math.max(0, Math.min(255, Math.round(r*m[6] + g*m[7] + b*m[8]))),
  };
}

/** B1: Convert '#rrggbb' hex string → { r, g, b } with values 0–1. */
function _hexToRgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >>  8) & 0xff) / 255,
    b: ( n        & 0xff) / 255,
  };
}

/** Feature 6: Apply master saturation 0-1 to an r,g,b triplet (0-255 each). */
function _applySaturation(r, g, b, sat) {
  if (sat === 1) return { r, g, b };
  const grey = Math.round(r * 0.299 + g * 0.587 + b * 0.114);
  return {
    r: Math.round(grey + (r - grey) * sat),
    g: Math.round(grey + (g - grey) * sat),
    b: Math.round(grey + (b - grey) * sat),
  };
}

// ── Feature 7: Gamma correction LUT ──────────────────────────────────────

let _gammaLut = null;
let _gammaLutValue = null;

function _buildGammaLut(gamma) {
  if (_gammaLutValue === gamma && _gammaLut) return _gammaLut;
  _gammaLut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    _gammaLut[i] = Math.round(Math.pow(i / 255, gamma) * 255);
  }
  _gammaLutValue = gamma;
  return _gammaLut;
}

// ── B4: Pattern @param parsing + slider rendering ─────────────────────────

/**
 * Scan pattern code for lines like:
 *   // @param name  float  defaultVal  min  max
 * Returns an array of { name, type, default: number, min: number, max: number }.
 */
function parseParams(code) {
  const re = /\/\/\s*@param\s+(\w+)\s+(\w+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)\s+([\d.eE+\-]+)/g;
  const result = [];
  let m;
  while ((m = re.exec(code)) !== null) {
    result.push({
      name:    m[1],
      type:    m[2],
      default: parseFloat(m[3]),
      min:     parseFloat(m[4]),
      max:     parseFloat(m[5]),
    });
  }
  return result;
}

/** Render sliders into #params-container for the active pattern's @params. */
function renderParamSliders() {
  const container = document.getElementById('params-container');
  if (!container) return;
  const p = _activePattern();
  if (!p) { container.innerHTML = ''; return; }

  const defs = parseParams(p.code);
  // Ensure storage entry exists
  if (!state.patternParams[p.id]) state.patternParams[p.id] = {};
  const vals = state.patternParams[p.id];

  // Set defaults for any new params
  defs.forEach(d => {
    if (vals[d.name] === undefined) vals[d.name] = d.default;
  });

  container.innerHTML = '';
  defs.forEach(def => {
    const row = document.createElement('div');
    row.className = 'param-row';
    const valDisplay = vals[def.name] !== undefined ? vals[def.name] : def.default;
    const step = (def.max - def.min) <= 1 ? 0.01 : ((def.max - def.min) <= 10 ? 0.1 : 1);
    row.innerHTML = `
      <label>${def.name}</label>
      <input type="range" min="${def.min}" max="${def.max}" step="${step}" value="${valDisplay}" data-param="${def.name}" />
      <span class="param-val">${valDisplay.toFixed(2)}</span>
      <button class="btn-lfo" data-param="${def.name}" title="Automate with LFO">LFO</button>
    `;
    const slider = row.querySelector('input[type=range]');
    const display = row.querySelector('.param-val');
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      state.patternParams[p.id][def.name] = v;
      display.textContent = v.toFixed(2);
    });

    // LFO toggle button
    const lfoKey = `${p.id}__${def.name}`;
    const lfoBtn = row.querySelector('.btn-lfo');
    const existingLfo = state.paramLfos[lfoKey];
    if (existingLfo?.enabled) lfoBtn.classList.add('active');

    lfoBtn.addEventListener('click', () => {
      const isActive = lfoBtn.classList.toggle('active');
      if (isActive) {
        // Show LFO controls inline
        if (!row.nextSibling || !row.nextSibling.classList?.contains('lfo-row')) {
          const lfo = state.paramLfos[lfoKey] ?? { enabled: true, shape: 'sine', rate: 1, depth: 0.5 };
          lfo.enabled = true;
          state.paramLfos[lfoKey] = lfo;
          const lfoRow = document.createElement('div');
          lfoRow.className = 'lfo-row';
          lfoRow.innerHTML = `
            <label>shape</label>
            <select class="lfo-shape">
              <option value="sine"${lfo.shape === 'sine' ? ' selected' : ''}>sine</option>
              <option value="triangle"${lfo.shape === 'triangle' ? ' selected' : ''}>tri</option>
              <option value="square"${lfo.shape === 'square' ? ' selected' : ''}>sq</option>
              <option value="random"${lfo.shape === 'random' ? ' selected' : ''}>rnd</option>
            </select>
            <label>rate</label>
            <input type="number" class="lfo-rate" value="${lfo.rate}" min="0.01" max="10" step="0.1" />
            <label>depth</label>
            <input type="number" class="lfo-depth" value="${lfo.depth}" min="0" max="1" step="0.01" />
          `;
          lfoRow.querySelector('.lfo-shape').addEventListener('change', e => {
            state.paramLfos[lfoKey].shape = e.target.value;
          });
          lfoRow.querySelector('.lfo-rate').addEventListener('input', e => {
            state.paramLfos[lfoKey].rate = parseFloat(e.target.value) || 1;
          });
          lfoRow.querySelector('.lfo-depth').addEventListener('input', e => {
            state.paramLfos[lfoKey].depth = parseFloat(e.target.value) || 0;
          });
          row.insertAdjacentElement('afterend', lfoRow);
        }
      } else {
        // Remove LFO controls
        if (row.nextSibling?.classList?.contains('lfo-row')) {
          row.nextSibling.remove();
        }
        if (state.paramLfos[lfoKey]) state.paramLfos[lfoKey].enabled = false;
      }
    });

    container.appendChild(row);
  });
}

// ── B3: Scene presets ─────────────────────────────────────────────────────

function saveScene(name) {
  const scene = {
    id:               crypto.randomUUID(),
    name,
    masterSpeed:      state.masterSpeed,
    masterBrightness: state.masterBrightness,
    masterSaturation: state.masterSaturation,  // Feature 6
    crossfadeDuration: state.crossfadeDuration, // Feature 14
    bpm:              state.bpm,
    palette:          [...state.palette],
    strips: state.strips.map(s => ({
      id:         s.id,
      speed:      s.speed,
      brightness: s.brightness,
      hueShift:   s.hueShift,
      reversed:   s.reversed,
      visible:    s.visible,
      patternId:  s.patternId ?? null,  // C1
    })),
    groups: state.groups.map(g => ({    // C3
      id:         g.id,
      speed:      g.speed,
      brightness: g.brightness,
      hueShift:   g.hueShift,
      visible:    g.visible,
      patternId:  g.patternId ?? null,
    })),
  };
  state.scenes.push(scene);
  state.activeSceneId = scene.id;
  _renderSceneSelect();
  return scene;
}

function recallScene(id, crossfade = true) {
  const scene = state.scenes.find(s => s.id === id);
  if (!scene) return;

  // Feature 14: snapshot current frame for crossfade
  if (crossfade && state.crossfadeDuration > 0 && state.lastFrame.length > 0) {
    state._crossfadeFrom  = new Uint8Array(state.lastFrame);
    state._crossfadeStart = performance.now();
    state._crossfadeTarget = id;
  }

  state.activeSceneId = id;

  state.masterSpeed      = scene.masterSpeed;
  state.masterBrightness = scene.masterBrightness;
  state.bpm              = scene.bpm;
  state.palette          = [...scene.palette];

  // Feature 6: restore master saturation
  if (scene.masterSaturation != null) {
    state.masterSaturation = scene.masterSaturation;
    const satSlider = document.getElementById('master-saturation');
    if (satSlider) {
      /** @type {HTMLInputElement} */ (satSlider).value = String(Math.round(state.masterSaturation * 100));
      const satVal = document.getElementById('master-saturation-val');
      if (satVal) satVal.textContent = Math.round(state.masterSaturation * 100) + '%';
    }
  }

  // Feature 14: restore crossfade duration
  if (scene.crossfadeDuration != null) {
    state.crossfadeDuration = scene.crossfadeDuration;
    const cfSlider = document.getElementById('crossfade-duration');
    if (cfSlider) {
      /** @type {HTMLInputElement} */ (cfSlider).value = String(state.crossfadeDuration);
      const cfVal = document.getElementById('crossfade-duration-val');
      if (cfVal) cfVal.textContent = (state.crossfadeDuration / 1000).toFixed(1) + 's';
    }
  }

  // Sync master speed UI
  const msSlider = document.getElementById('master-speed');
  if (msSlider) {
    /** @type {HTMLInputElement} */ (msSlider).value = String(Math.round(state.masterSpeed * 100));
    document.getElementById('master-speed-val').textContent = state.masterSpeed.toFixed(2) + '×';
  }
  // Sync master brightness UI
  const mbSlider = document.getElementById('master-brightness');
  if (mbSlider) {
    const pct = Math.round(state.masterBrightness * 100);
    /** @type {HTMLInputElement} */ (mbSlider).value = String(pct);
    document.getElementById('master-brightness-val').textContent = pct + '%';
  }
  // Sync BPM UI
  const bpmInput = document.getElementById('bpm-input');
  if (bpmInput) /** @type {HTMLInputElement} */ (bpmInput).value = String(state.bpm);

  // Sync palette swatches
  state.palette.forEach((hex, i) => {
    const sw = document.getElementById(`pal-${i}`);
    if (sw) /** @type {HTMLInputElement} */ (sw).value = hex;
  });

  // Apply per-strip overrides
  const byId = new Map(scene.strips.map(s => [s.id, s]));
  state.strips.forEach(strip => {
    const saved = byId.get(strip.id);
    if (!saved) return;
    strip.speed      = saved.speed;
    strip.brightness = saved.brightness;
    strip.hueShift   = saved.hueShift;
    strip.reversed   = saved.reversed;
    strip.patternId  = saved.patternId ?? null; // C1
    if (strip.visible !== saved.visible) {
      canvasManager.toggleStripVisible(strip.id);
      strip.visible = saved.visible;
    }
    // BUG 2: re-sample pixels so reversed order is actually applied
    const pathEl2 = canvasManager.getPathEl(strip.id);
    if (pathEl2) {
      strip.pixels = samplePath(pathEl2, strip.pixelCount);
      if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    }
  });

  // C3: restore group overrides
  if (Array.isArray(scene.groups)) {
    const byGId = new Map(scene.groups.map(g => [g.id, g]));
    state.groups.forEach(group => {
      const saved = byGId.get(group.id);
      if (!saved) return;
      group.speed      = saved.speed;
      group.brightness = saved.brightness;
      group.hueShift   = saved.hueShift;
      group.visible    = saved.visible;
      group.patternId  = saved.patternId ?? null;
    });
  }

  _rebuildNorm();
  renderStripsList();
}

function _renderSceneSelect() {
  const sel = document.getElementById('scene-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— no scene —</option>';
  state.scenes.forEach(s => {
    const opt = Object.assign(document.createElement('option'), {
      value: s.id, textContent: s.name,
      selected: s.id === state.activeSceneId,
    });
    sel.appendChild(opt);
  });
}

// ── Feature 14: Crossfade tick ────────────────────────────────────────────

function _tickCrossfade() {
  if (!state._crossfadeStart || !state._crossfadeFrom) return false;
  const elapsed = (performance.now() - state._crossfadeStart);
  const progress = Math.min(1, elapsed / state.crossfadeDuration);
  // Update progress bar
  const bar = document.getElementById('crossfade-progress');
  if (bar) {
    bar.style.width = (progress * 100) + '%';
    if (progress >= 1) bar.classList.remove('active');
    else bar.classList.add('active');
  }
  if (progress >= 1) {
    state._crossfadeFrom  = null;
    state._crossfadeStart = null;
    state._crossfadeTarget = null;
    return false;
  }
  return true;
}

// ── Animation loop ────────────────────────────────────────────────────────

function startAnim() {
  if (state.animating) return;
  state.animating  = true;
  state.lastTs     = null;
  state.fpsHistory = [];
  state.rafId      = requestAnimationFrame(_tick);
  document.getElementById('btn-stop-pattern').disabled = false;
  const brp = document.getElementById('btn-run-pattern');
  brp.textContent = '↺ Running'; brp.classList.add('running');
  previewRenderer._animating = true;
  // C2: start WLED push if connected
  if (state.wledConnected) {
    clearInterval(state.wledPushHandle);
    state.wledPushHandle = setInterval(_pushToWLED, 40);
  }
  // Sync toolbar play/stop buttons
  const pb = document.getElementById('btn-play-toolbar');
  if (pb) { pb.textContent = '■ Stop'; pb.classList.add('running'); pb.title = 'Stop pattern (Space)'; }
  // Sync pattern tab play/stop buttons
  const pbc = document.getElementById('btn-play-cards');
  if (pbc) { pbc.textContent = '■ Stop'; pbc.classList.add('running'); pbc.title = 'Stop (P)'; }
}

function stopAnim() {
  state.animating = false;
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  // C2: stop WLED push
  clearInterval(state.wledPushHandle);
  state.wledPushHandle = null;
  document.getElementById('status-fps').textContent = 'FPS: —';
  const brp = document.getElementById('btn-run-pattern');
  brp.textContent = '▶ Run'; brp.classList.remove('running');
  document.getElementById('btn-stop-pattern').disabled = true;
  previewRenderer._animating = false;
  previewRenderer.renderStatic();
  // Sync toolbar play/stop buttons
  const pb = document.getElementById('btn-play-toolbar');
  if (pb) { pb.textContent = '▶ Play'; pb.classList.remove('running'); pb.title = 'Run pattern (Space)'; }
  // Sync pattern tab play/stop buttons
  const pbc = document.getElementById('btn-play-cards');
  if (pbc) { pbc.textContent = '▶ Play'; pbc.classList.remove('running'); pbc.title = 'Play (P)'; }
}

function _computeLfoValue(lfo, t) {
  const phase = (t * lfo.rate) % 1;
  let mod;
  switch (lfo.shape) {
    case 'triangle': mod = phase < 0.5 ? phase * 2 : 2 - phase * 2; break;
    case 'square':   mod = phase < 0.5 ? 1 : 0; break;
    case 'random':   mod = (Math.sin(Math.floor(t * lfo.rate) * 127.1) * 43758.5453) % 1; mod = mod < 0 ? mod + 1 : mod; break;
    default:         mod = (Math.sin(phase * Math.PI * 2) + 1) * 0.5; // sine
  }
  return mod * lfo.depth;
}

function _tick(ts) {
  if (!state.animating) return;
  if (state.lastTs == null) state.lastTs = ts;
  const dt = Math.min((ts - state.lastTs) / 1000, 0.1);
  state.lastTs = ts;

  // Global unscaled time (used for the status bar and as a fallback)
  state.t    += dt;
  state.time  = (state.t % 65.536) / 65.536;

  // C3: build group lookup once per frame
  const groupByStrip = new Map();
  for (const g of state.groups) {
    for (const sid of g.stripIds) groupByStrip.set(sid, g);
  }

  // Advance each strip's independent time by dt × effectiveSpeed × masterSpeed.
  const master = state.masterSpeed;
  for (const strip of state.strips) {
    if (strip.visible === false) continue;
    const group = groupByStrip.get(strip.id);
    const effectiveSpeed = group?.speed ?? strip.speed ?? 1.0;
    const prev    = state.stripTimes.get(strip.id) ?? { t: 0, time: 0 };
    const newT    = prev.t + dt * effectiveSpeed * master;
    state.stripTimes.set(strip.id, {
      t:    newT,
      time: (newT % 65.536) / 65.536,
    });
  }

  if (dt > 0) {
    state.fpsHistory.push(1 / dt);
    if (state.fpsHistory.length > 60) state.fpsHistory.shift();
    const fps = Math.round(state.fpsHistory.reduce((a, b) => a + b, 0) / state.fpsHistory.length);
    document.getElementById('status-fps').textContent = `FPS: ${fps}`;
  }

  if (state.compiledFns.size && state.normalisedPixels.length) {
    const pixelCount = state.normalisedPixels.length;
    const stripTimes = state.stripTimes;

    // B1: build palette as {r,g,b} 0-1 objects once per frame
    const paletteRgb = state.palette.map(_hexToRgb01);

    // LFO: apply parameter automation
    const _lfoModdedParams = new Map(); // patternId → { paramName → value }
    if (Object.keys(state.paramLfos).length) {
      for (const [key, lfo] of Object.entries(state.paramLfos)) {
        if (!lfo.enabled) continue;
        const sep = key.indexOf('__');
        if (sep < 0) continue;
        const patId = key.slice(0, sep);
        const paramName = key.slice(sep + 2);
        const pattern = state.patterns.find(p => p.id === patId);
        if (!pattern) continue;
        const params = state.patternParams[patId] ?? {};
        const baseVal = params[paramName] ?? 0;
        const lfoVal = _computeLfoValue(lfo, state.t);
        if (!_lfoModdedParams.has(patId)) _lfoModdedParams.set(patId, { ...params });
        _lfoModdedParams.get(patId)[paramName] = baseVal + lfoVal;
      }
    }

    // B2: compute beat variables
    const beatPeriod = 60 / state.bpm;
    const beat       = ((state.t - state.beatStart) % beatPeriod) / beatPeriod;
    const beatSin    = (Math.sin(beat * Math.PI * 2) + 1) * 0.5;

    // C2: capture last frame
    const lastFrame = new Uint8Array(pixelCount * 3);

    // Feature 7: build gamma LUT once per frame (not per pixel)
    const gammaLut = state.gammaEnabled ? _buildGammaLut(state.gammaValue) : null;

    // PERF 2: build per-strip context once per frame (not per pixel)
    const perStripCtx = new Map();
    for (const strip of state.strips) {
      if (strip.visible === false) continue;
      const group = groupByStrip.get(strip.id);
      const effectivePatternId  = group?.patternId  ?? strip.patternId  ?? state.activePatternId;
      const effectiveHueShift   = group?.hueShift   ?? strip.hueShift   ?? 0;
      const effectiveBrightness = (group?.brightness ?? strip.brightness ?? 1.0) * state.masterBrightness;
      const fn     = state.compiledFns.get(effectivePatternId) ?? null;
      const params = _lfoModdedParams.get(effectivePatternId) ?? state.patternParams[effectivePatternId] ?? {};
      const st     = stripTimes.get(strip.id) ?? { t: state.t, time: state.time };
      const hueMatrix = effectiveHueShift ? _hueRotateMatrix(effectiveHueShift) : null;
      perStripCtx.set(strip.id, { fn, params, st, hueMatrix, brightness: effectiveBrightness });
    }

    const _colorFn = (i, nx, ny, stripId) => {
      const pxData = state.normalisedPixels[i];
      // Use chain root's context so pattern/speed flows through the whole chain
      const effectiveId = pxData.chainRootId ?? stripId;
      const ctx = perStripCtx.get(effectiveId) ?? perStripCtx.get(stripId);
      if (!ctx?.fn) return { r: 0, g: 0, b: 0 };

      const patternIndex = pxData.chainIndex ?? pxData.index ?? i;
      const patternTotal = pxData.chainTotal ?? pixelCount;

      const stripProgress = pxData.stripIndex / Math.max((pxData.stripTotal || 1) - 1, 1);
      let { r, g, b } = evalPixel(ctx.fn, patternIndex, nx, ny, ctx.st.t, ctx.st.time, patternTotal, paletteRgb, beat, beatSin, ctx.params, pxData.stripId, stripProgress);

      // A3: hue shift
      if (ctx.hueMatrix) ({ r, g, b } = _applyHueMatrix(r, g, b, ctx.hueMatrix));

      // A1+A2: combined brightness
      r = Math.round(r * ctx.brightness);
      g = Math.round(g * ctx.brightness);
      b = Math.round(b * ctx.brightness);

      // Feature 6: master saturation
      if (state.masterSaturation < 1) {
        ({ r, g, b } = _applySaturation(r, g, b, state.masterSaturation));
      }

      // Feature 7: gamma correction
      if (gammaLut) { r = gammaLut[r]; g = gammaLut[g]; b = gammaLut[b]; }

      lastFrame[i * 3]     = r;
      lastFrame[i * 3 + 1] = g;
      lastFrame[i * 3 + 2] = b;

      return { r, g, b };
    };
    previewRenderer._frozenColorFn = _colorFn;
    previewRenderer.render(_colorFn);

    state.lastFrame = lastFrame;

    // Feature 14: crossfade blend
    if (state._crossfadeFrom && state._crossfadeStart) {
      const elapsed  = performance.now() - state._crossfadeStart;
      const progress = Math.min(1, elapsed / state.crossfadeDuration);
      for (let i = 0; i < state.lastFrame.length; i++) {
        state.lastFrame[i] = Math.round(
          state._crossfadeFrom[i] * (1 - progress) + state.lastFrame[i] * progress
        );
      }
      _tickCrossfade();
    }
  }

  state.rafId = requestAnimationFrame(_tick);
}

// ── C2: WLED live push ────────────────────────────────────────────────────

function _pushToWLED() {
  if (!state.wledConnected || !state.lastFrame.length) return;
  if (!state.wledWs || state.wledWs.readyState !== WebSocket.OPEN) return;
  const len = state.lastFrame.length;
  if (_wledBuf.length !== len) _wledBuf = new Array(len);
  for (let i = 0; i < len; i++) _wledBuf[i] = state.lastFrame[i];
  try {
    state.wledWs.send(JSON.stringify({ on: true, seg: [{ i: _wledBuf }] }));
    state.wledPushCount++;
    const el = document.getElementById('wled-push-count');
    if (el) el.textContent = `${state.wledPushCount} sent`;
  } catch { /* websocket busy or closing */ }
}

function _pushToWLEDHttp() {
  if (!state.wledConnected || !state.lastFrame.length) return;
  const len = state.lastFrame.length;
  if (_wledBuf.length !== len) _wledBuf = new Array(len);
  for (let i = 0; i < len; i++) _wledBuf[i] = state.lastFrame[i];
  fetch(`http://${state.wledIp}/json`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ on: true, seg: [{ i: _wledBuf }] }),
  })
  .then(() => {
    state.wledPushCount++;
    const el = document.getElementById('wled-push-count');
    if (el) el.textContent = `${state.wledPushCount} sent`;
  })
  .catch(() => {});
}

function _openWledWs(ip) {
  if (state.wledWs) { try { state.wledWs.close(); } catch {} state.wledWs = null; }
  const ws = new WebSocket(`ws://${ip}/ws`);
  ws.onopen = () => {
    state.wledWs = ws;
    showToast('WLED WebSocket open', 'success');
  };
  ws.onerror = () => {
    // Fall back gracefully — HTTP push still works but won't be used
    showToast('WLED WS unavailable — using HTTP fallback', '');
    state.wledWs = null;
    // Switch back to HTTP push mode
    clearInterval(state.wledPushHandle);
    state.wledPushHandle = setInterval(_pushToWLEDHttp, 40);
  };
  ws.onclose = () => { state.wledWs = null; };
}

async function _wledConnect() {
  const ipInput = /** @type {HTMLInputElement} */ (document.getElementById('wled-ip'));
  const btn     = document.getElementById('btn-wled-connect');
  const status  = document.getElementById('wled-status');

  if (state.wledConnected) {
    clearInterval(state.wledPushHandle);
    state.wledPushHandle = null;
    if (state.wledWs) { try { state.wledWs.close(); } catch {} state.wledWs = null; }
    state.wledConnected  = false;
    btn.textContent      = 'Connect';
    status.textContent   = '';
    status.className     = 'wled-status';
    return;
  }

  const ip = ipInput.value.trim();
  if (!ip) { status.textContent = 'Enter IP'; return; }
  state.wledIp = ip;

  status.textContent  = '● Connecting…';
  status.className    = 'wled-status';
  try {
    const res = await fetch(`http://${ip}/json/info`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('not ok');
    const info = await res.json();
    state.wledConnected = true;
    btn.textContent    = 'Disconnect';
    status.textContent = `● ${info.name || 'Connected'}`;
    status.className   = 'wled-status wled-connected';

    // Feature 5: LED count warning
    const totalLEDs = state.strips.reduce((n, s) => n + s.pixelCount, 0);
    if (totalLEDs > 1500) {
      showToast(`Warning: ${totalLEDs} LEDs exceeds WLED default limit (1500). Check your WLED LED count setting.`, 'warn');
    }

    // Open WebSocket for low-latency push (falls back to HTTP if unavailable)
    _openWledWs(ip);
  } catch {
    state.wledConnected = false;
    status.textContent  = '✕ Unreachable';
    status.className    = 'wled-status';
    showToast('Could not reach WLED device', 'warn');
    return;
  }

  if (state.animating) {
    clearInterval(state.wledPushHandle);
    state.wledPushHandle = setInterval(_pushToWLED, 40);
  }
}

// ── MIDI ─────────────────────────────────────────────────────────────────

async function _initMIDI() {
  if (!navigator.requestMIDIAccess) {
    showToast('Web MIDI not supported in this browser', 'error');
    return;
  }
  try {
    state.midiAccess = await navigator.requestMIDIAccess();
    _bindMIDIInputs();
    state.midiAccess.onstatechange = _bindMIDIInputs;
    const names = [...state.midiAccess.inputs.values()].map(i => i.name).join(', ');
    showToast('MIDI connected — ' + (names || 'no devices found'));
    document.getElementById('btn-midi-enable')?.classList.add('active');
    const statusEl = document.getElementById('midi-status');
    if (statusEl) { statusEl.textContent = names || 'connected'; statusEl.classList.add('connected'); }
  } catch (e) {
    showToast('MIDI access denied: ' + e.message, 'error');
  }
}

function _bindMIDIInputs() {
  if (!state.midiAccess) return;
  for (const input of state.midiAccess.inputs.values()) {
    input.onmidimessage = _onMIDIMessage;
  }
}

function _onMIDIMessage(e) {
  const [status, cc, value] = e.data;
  // Only handle Control Change messages (0xB0 = 176)
  if ((status & 0xF0) !== 0xB0) return;
  const norm = value / 127;

  if (state.midiLearn && state.midiLearnTarget) {
    state.midiMappings[cc] = { target: state.midiLearnTarget, min: 0, max: 1 };
    state.midiLearn = false;
    state.midiLearnTarget = null;
    document.getElementById('btn-midi-learn')?.classList.remove('active');
    showToast(`MIDI CC ${cc} → ${state.midiMappings[cc].target}`);
    return;
  }

  const mapping = state.midiMappings[cc];
  if (!mapping) return;
  const val = mapping.min + norm * (mapping.max - mapping.min);

  switch (mapping.target) {
    case 'masterSpeed': {
      state.masterSpeed = val * 4;
      const el = document.getElementById('master-speed');
      if (el) { el.value = val * 400; el.dispatchEvent(new Event('input')); }
      break;
    }
    case 'masterBrightness': {
      state.masterBrightness = val;
      const el = document.getElementById('master-brightness');
      if (el) { el.value = val * 100; el.dispatchEvent(new Event('input')); }
      break;
    }
    case 'bpm': {
      const bpm = Math.round(60 + val * 140); // 60–200 BPM
      state.bpm = bpm;
      const el = document.getElementById('bpm-input');
      if (el) el.value = bpm;
      break;
    }
    default: {
      // param:patternId.paramName
      if (mapping.target.startsWith('param:')) {
        const rest = mapping.target.slice(6);
        const dot = rest.indexOf('.');
        const patId = rest.slice(0, dot);
        const paramName = rest.slice(dot + 1);
        if (!state.patternParams[patId]) state.patternParams[patId] = {};
        state.patternParams[patId][paramName] = val;
        // Update slider UI if visible
        document.querySelectorAll(`[data-param="${paramName}"]`).forEach(el => {
          if (el.tagName === 'INPUT') el.value = val;
        });
      }
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────

function _exportOpts() {
  return {
    normalize: /** @type {HTMLInputElement} */ (document.getElementById('export-normalize')).checked,
    scaleX:  parseFloat(document.getElementById('export-scale-x').value)  || 1,
    scaleY:  parseFloat(document.getElementById('export-scale-y').value)  || 1,
    offsetX: parseFloat(document.getElementById('export-offset-x').value) || 0,
    offsetY: parseFloat(document.getElementById('export-offset-y').value) || 0,
  };
}

function syncExportInfo() {
  const total = state.strips.reduce((n, s) => n + s.pixelCount, 0);
  document.getElementById('export-total').textContent = total;
  const vb = svgEl.viewBox.baseVal;
  document.getElementById('export-canvas-size').textContent =
    `${Math.round(vb.width)} × ${Math.round(vb.height)}`;
  // Feature 13: update scale overlay
  _updateScaleOverlay();
}

function refreshExportPreview() {
  const pixels = getAllPixels(state.strips);
  const el     = document.getElementById('export-preview');
  if (!pixels.length) { el.textContent = '(no sections defined)'; return; }
  const full  = toWLEDLedmap(pixels, _exportOpts());
  // Feature 10: show full export preview without truncation
  el.textContent = full;
}

// ── Feature 13: Physical scale overlay ───────────────────────────────────

function _updateScaleOverlay() {
  const el = document.getElementById('scale-overlay');
  if (!el) return;
  const vb = svgEl.viewBox.baseVal;
  const pxPerMm = _getPxPerMm();
  const wMm = vb.width  / pxPerMm;
  const hMm = vb.height / pxPerMm;
  const fmt = mm => mm >= 1000 ? (mm/1000).toFixed(2) + 'm' : Math.round(mm) + 'mm';
  el.textContent = `${fmt(wMm)} × ${fmt(hMm)}`;
}

// ── Strip floating popup ──────────────────────────────────────────────────

function _showStripPopup(strip) {
  const popup = document.getElementById('strip-popup');
  if (!popup || !strip?.pixels?.length) { _hideStripPopup(); return; }

  const wRect = wrapper.getBoundingClientRect();
  const lastStripId = popup.dataset.openStripId;
  const wasDragged  = popup.dataset.dragged === '1';

  // Reposition only when opening a different strip, or first open
  if (!wasDragged || lastStripId !== strip.id) {
    popup.dataset.dragged = '';

    const pw = popup.offsetWidth  || 220;
    const ph = popup.offsetHeight || 170;
    const m  = 12;

    // Count how many of this strip's pixels fall in each canvas quadrant,
    // using SVG→screen coordinate transform so zoom/pan is accounted for.
    const ctm = svgEl.getScreenCTM();
    const quadrantCount = [0, 0, 0, 0]; // TL, TR, BL, BR
    const midX = wRect.left + wRect.width  / 2;
    const midY = wRect.top  + wRect.height / 2;
    for (const p of strip.pixels) {
      const pt = svgEl.createSVGPoint();
      pt.x = p.x; pt.y = p.y;
      const sp = pt.matrixTransform(ctm);
      const qx = sp.x > midX ? 1 : 0;
      const qy = sp.y > midY ? 1 : 0;
      quadrantCount[qy * 2 + qx]++;
    }

    // Place popup in the quadrant with the fewest LEDs
    const corners = [
      { x: m,                    y: m },                          // TL
      { x: wRect.width - pw - m, y: m },                          // TR
      { x: m,                    y: wRect.height - ph - m },      // BL
      { x: wRect.width - pw - m, y: wRect.height - ph - m },      // BR
    ];
    let best = corners[0], bestIdx = 0;
    for (let i = 1; i < 4; i++) {
      if (quadrantCount[i] < quadrantCount[bestIdx]) { bestIdx = i; best = corners[i]; }
    }
    popup.style.left = `${best.x}px`;
    popup.style.top  = `${best.y}px`;
  }
  popup.dataset.openStripId = strip.id;

  popup.querySelector('.popup-strip-name').textContent = strip.name;
  const inp = /** @type {HTMLInputElement} */ (popup.querySelector('#popup-pixels-input'));
  inp.value = String(strip.pixelCount);
  inp.dataset.stripId = strip.id;
  const lenMmVal = strip.svgLength ? _toMm(strip.svgLength) : 0;
  const pitchMm  = lenMmVal && strip.pixelCount > 1 ? (lenMmVal / (strip.pixelCount - 1)).toFixed(1) : '—';
  const lenMm = lenMmVal ? `${_fmtMm(lenMmVal)} mm` : '—';
  popup.querySelector('.popup-length').textContent = lenMm;
  const pitchEl = popup.querySelector('.popup-pitch');
  if (pitchEl) pitchEl.textContent = pitchMm !== '—' ? `${pitchMm} mm/LED` : '—';

  // Pattern selector
  const patSel = popup.querySelector('#popup-pattern-select');
  if (patSel) {
    patSel.innerHTML = '<option value="">— none —</option>' +
      state.patterns.map(p => `<option value="${p.id}"${strip.patternId === p.id ? ' selected' : ''}>${p.name}</option>`).join('');
    patSel.onchange = () => {
      strip.patternId = patSel.value || null;
      renderStripsList();
      _markDirty();
    };
  }

  // ── Emit direction compass ────────────────────────────────────────────────
  // Clean up previous compass listeners before setting up for this strip
  if (_compassMoveHandler) document.removeEventListener('mousemove', _compassMoveHandler);
  if (_compassUpHandler)   document.removeEventListener('mouseup',   _compassUpHandler);

  _compassStripId  = strip.id;
  _compassDragging = false;

  const compass = /** @type {HTMLCanvasElement} */ (popup.querySelector('#popup-compass'));
  const emitLbl = popup.querySelector('#popup-emit-label');
  const emitClr = popup.querySelector('#popup-emit-clear');

  if (compass) {
    _drawCompass(compass, strip.emitAngle ?? null);
    if (emitLbl) emitLbl.textContent = strip.emitAngle != null ? `${Math.round(strip.emitAngle)}°` : 'Omnidirectional';

    compass.onmousedown = e => {
      if (e.button !== 0) return;
      _compassDragging = true;
      _applyCompassAngle(e);
    };

    _compassMoveHandler = e => {
      if (!_compassDragging) return;
      _applyCompassAngle(e);
    };
    _compassUpHandler = () => { _compassDragging = false; };

    document.addEventListener('mousemove', _compassMoveHandler);
    document.addEventListener('mouseup',   _compassUpHandler);
  }

  if (emitClr) {
    emitClr.onclick = () => {
      const s = state.strips.find(x => x.id === _compassStripId);
      if (!s) return;
      s.emitAngle = null;
      if (compass) _drawCompass(compass, null);
      if (emitLbl) emitLbl.textContent = 'Omnidirectional';
      _markDirty();
      if (previewRenderer._coverageColorMap) previewRenderer.showCoverage(_coverageColorMap(), _coverageAngleMap());
      if (previewRenderer.directedMode) previewRenderer.setEmitAngles(_coverageAngleMap());
      canvasManager.refreshEmitDirection(s.id);
    };
  }

  popup.classList.remove('hidden');
}

function _hideStripPopup() {
  const popup = document.getElementById('strip-popup');
  if (!popup) return;
  popup.classList.add('hidden');
  popup.dataset.dragged = '';
  if (_compassMoveHandler) { document.removeEventListener('mousemove', _compassMoveHandler); _compassMoveHandler = null; }
  if (_compassUpHandler)   { document.removeEventListener('mouseup',   _compassUpHandler);   _compassUpHandler   = null; }
  _compassDragging = false;
}

function _initPopupDrag() {
  const popup = document.getElementById('strip-popup');
  let dragging = false, ox = 0, oy = 0;

  function _startDrag(clientX, clientY, target) {
    // Don't drag if the user clicked an interactive element
    if (target.closest('input,select,button')) return;
    dragging = true;
    ox = clientX - popup.offsetLeft;
    oy = clientY - popup.offsetTop;
    popup.style.cursor = 'grabbing';
  }
  function _moveDrag(clientX, clientY) {
    if (!dragging) return;
    const wRect = wrapper.getBoundingClientRect();
    const nx = Math.max(0, Math.min(clientX - ox, wRect.width  - popup.offsetWidth));
    const ny = Math.max(0, Math.min(clientY - oy, wRect.height - popup.offsetHeight));
    popup.style.left = `${nx}px`;
    popup.style.top  = `${ny}px`;
    popup.dataset.dragged = '1';
  }
  function _endDrag() {
    dragging = false;
    popup.style.cursor = '';
  }

  // Mouse
  popup.addEventListener('mousedown', e => _startDrag(e.clientX, e.clientY, e.target));
  document.addEventListener('mousemove', e => _moveDrag(e.clientX, e.clientY));
  document.addEventListener('mouseup', _endDrag);

  // Touch
  popup.addEventListener('touchstart', e => {
    const t = e.touches[0];
    _startDrag(t.clientX, t.clientY, e.target);
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!dragging) return;
    e.preventDefault();
    const t = e.touches[0];
    _moveDrag(t.clientX, t.clientY);
  }, { passive: false });
  document.addEventListener('touchend', _endDrag);
}

function _updateMultiSelectBar() {
  const bar = document.getElementById('multi-select-bar');
  if (!bar) return;
  const count = state.selectedIds.size;
  if (count > 1) {
    bar.querySelector('.msel-count').textContent = `${count} sections selected`;
    bar.classList.add('visible');
  } else {
    bar.classList.remove('visible');
  }
}

// ── Feature 11: Canvas zoom + pan ─────────────────────────────────────────

function _applyCanvasTransform() {
  svgEl.style.transformOrigin = '0 0';
  svgEl.style.transform = `translate(${state.canvasPanX}px, ${state.canvasPanY}px) scale(${state.canvasZoom})`;
  if (previewRenderer.setTransform) previewRenderer.setTransform(state.canvasPanX, state.canvasPanY, state.canvasZoom);
  const zl = document.getElementById('zoom-level');
  if (zl) zl.textContent = Math.round(state.canvasZoom * 100) + '%';
}

function _zoomCanvas(factor, cx, cy) {
  const rect = wrapper.getBoundingClientRect();
  const px = (cx ?? rect.width / 2);
  const py = (cy ?? rect.height / 2);
  const prevZoom = state.canvasZoom;
  state.canvasZoom = Math.max(0.1, Math.min(8, state.canvasZoom * factor));
  const scale = state.canvasZoom / prevZoom;
  state.canvasPanX = px + (state.canvasPanX - px) * scale;
  state.canvasPanY = py + (state.canvasPanY - py) * scale;
  _applyCanvasTransform();
}

function _resetZoom() {
  state.canvasZoom = 1;
  state.canvasPanX = 0;
  state.canvasPanY = 0;
  _applyCanvasTransform();
}

// ── Feature 12: LED hover tooltip ─────────────────────────────────────────

let _ledTooltip = null;
function _getTooltip() {
  if (!_ledTooltip) {
    _ledTooltip = document.createElement('div');
    _ledTooltip.className = 'led-tooltip hidden';
    _ledTooltip.id = 'led-tooltip';
    document.body.appendChild(_ledTooltip);
  }
  return _ledTooltip;
}

// ── Project save / load ───────────────────────────────────────────────────

function saveProject() {
  _isDirty = false;
  _saveEditorToPattern();
  const data = {
    version: 3,
    strips:            state.strips.map(({ pixels: _px, ...s }) => s),
    patterns:          state.patterns,
    activePatternId:   state.activePatternId,
    palette:           state.palette,
    bpm:               state.bpm,
    scenes:            state.scenes,
    patternParams:     state.patternParams,
    groups:            state.groups,  // C3
    connections:       state.connections,
    masterSaturation:  state.masterSaturation,
    gammaEnabled:      state.gammaEnabled,
    gammaValue:        state.gammaValue,
    ledTypeId:         state.ledTypeId,
    artworkLayerState: state.artworkLayers.map(l => ({ layerId: l.layerId, _hidden: l._hidden || false, _color: l._color })),
  };
  download(JSON.stringify(data, null, 2), 'led-project.json');
}

async function loadProject(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { showToast('Could not parse project file.', 'warn'); return; }

  canvasManager.clearCanvas();
  state.strips = [];

  state.stripTimes.clear();
  (data.strips || []).forEach(strip => {
    canvasManager.addStrip(strip);
    const pathEl     = canvasManager.getPathEl(strip.id);
    strip.svgLength  = strip.svgLength  ?? pathEl?.getTotalLength() ?? 0;
    strip.pixels     = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
    strip.visible    = strip.visible    ?? true;
    strip.speed      = strip.speed      ?? 1.0;
    strip.brightness = strip.brightness ?? 1.0;
    strip.hueShift   = strip.hueShift   ?? 0;
    strip.reversed   = strip.reversed   ?? false;
    strip.patternId  = strip.patternId  ?? null; // C1
    if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    // Apply drag offset saved in project — pixels sampled at origin, need shift
    if (strip.offsetX || strip.offsetY) {
      const ox = strip.offsetX || 0, oy = strip.offsetY || 0;
      strip.pixels.forEach(px => { px.x += ox; px.y += oy; });
    }
    state.strips.push(strip);
    state.stripTimes.set(strip.id, { t: 0, time: 0 });
  });

  assignIndices(state.strips);
  if (data.patterns?.length) state.patterns = data.patterns;
  state.activePatternId = data.activePatternId || state.patterns[0]?.id;

  // Restore B-series state
  if (Array.isArray(data.palette) && data.palette.length === 6) {
    state.palette = data.palette;
    state.palette.forEach((hex, i) => {
      const sw = document.getElementById(`pal-${i}`);
      if (sw) /** @type {HTMLInputElement} */ (sw).value = hex;
    });
  }
  if (data.bpm) {
    state.bpm = data.bpm;
    const bpmInput = document.getElementById('bpm-input');
    if (bpmInput) /** @type {HTMLInputElement} */ (bpmInput).value = String(state.bpm);
  }
  if (Array.isArray(data.scenes)) {
    state.scenes = data.scenes;
    _renderSceneSelect();
  }
  if (data.patternParams) state.patternParams = data.patternParams;

  // C3: restore groups
  if (Array.isArray(data.groups)) {
    state.groups = data.groups;
  } else {
    state.groups = [];
  }

  // Restore global colour/gamma settings
  if (data.masterSaturation != null) {
    state.masterSaturation = data.masterSaturation;
    const satSlider = document.getElementById('master-saturation');
    const satVal    = document.getElementById('master-saturation-val');
    if (satSlider) /** @type {HTMLInputElement} */ (satSlider).value = String(Math.round(state.masterSaturation * 100));
    if (satVal)    satVal.textContent = Math.round(state.masterSaturation * 100) + '%';
  }
  if (data.gammaEnabled != null) {
    state.gammaEnabled = data.gammaEnabled;
    const cb = document.getElementById('gamma-enabled');
    if (cb) /** @type {HTMLInputElement} */ (cb).checked = state.gammaEnabled;
  }
  if (data.gammaValue != null) {
    state.gammaValue = data.gammaValue;
    const sel = document.getElementById('gamma-value');
    if (sel) /** @type {HTMLSelectElement} */ (sel).value = String(state.gammaValue);
  }
  if (data.ledTypeId) {
    state.ledTypeId = data.ledTypeId;
    const sel = document.getElementById('global-led-type');
    if (sel) /** @type {HTMLSelectElement} */ (sel).value = state.ledTypeId;
    _updateInspectorDensities();
  }

  _rebuildNorm();
  state.strips.forEach(s => canvasManager.setStripDots(s.id, s.pixels));
  if (Array.isArray(data.connections)) {
    state.connections = data.connections;
    _buildChainMap();
    canvasManager.renderConnections(state.connections);
  }
  // Restore layer visibility state — applied in onImportRequest when SVG is next loaded
  if (Array.isArray(data.artworkLayerState)) {
    state.artworkLayerState = data.artworkLayerState;
  }
  renderStripsList();
  renderPatternSelect();
  renderPatternCards();
  initEditor(_activePattern()?.code ?? '');
  renderParamSliders();
  syncExportInfo();
  _updateEmptyState();
  _lsSave();
}

// ── localStorage auto-save / restore (keeps state across HMR reloads) ────

const _LS_KEY = 'lw-autosave';

function _lsSave() {
  _saveEditorToPattern();
  const customs = state.patterns.filter(p => !_LIBRARY_IDS.has(p.id));
  const data = {
    version:           3,
    svgSource:         state._svgSource,
    strips:            state.strips.map(({ pixels: _px, ...s }) => s),
    customPatterns:    customs,
    activePatternId:   state.activePatternId,
    palette:           state.palette,
    bpm:               state.bpm,
    scenes:            state.scenes,
    activeSceneId:     state.activeSceneId,
    patternParams:     state.patternParams,
    groups:            state.groups,
    connections:       state.connections,
    masterSpeed:       state.masterSpeed,
    masterBrightness:  state.masterBrightness,
    masterSaturation:  state.masterSaturation,
    gammaEnabled:      state.gammaEnabled,
    gammaValue:        state.gammaValue,
    ledTypeId:         state.ledTypeId,
    wledIp:            state.wledIp,
    crossfadeDuration: state.crossfadeDuration,
    artworkLayerState: state.artworkLayers.map(l => ({
      layerId: l.layerId, _hidden: l._hidden || false, _color: l._color,
    })),
  };
  try { localStorage.setItem(_LS_KEY, JSON.stringify(data)); } catch {}
}

function _lsRestore() {
  let data;
  try {
    const raw = localStorage.getItem(_LS_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch { return; }

  // Restore SVG artwork first so strip paths can be measured against live SVG elements
  if (data.svgSource) {
    state._svgSource = data.svgSource;
    canvasManager.importSVG(data.svgSource, true);
    const vb = svgEl.viewBox.baseVal;
    if (vb && vb.width > 0) previewRenderer.setViewBox(vb.x, vb.y, vb.width, vb.height);
  }

  // Restore strips
  (data.strips || []).forEach(strip => {
    canvasManager.addStrip(strip);
    const pathEl      = canvasManager.getPathEl(strip.id);
    strip.svgLength   = strip.svgLength   ?? pathEl?.getTotalLength() ?? 0;
    strip.pixels      = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
    strip.visible     = strip.visible     ?? true;
    strip.speed       = strip.speed       ?? 1.0;
    strip.brightness  = strip.brightness  ?? 1.0;
    strip.hueShift    = strip.hueShift    ?? 0;
    strip.reversed    = strip.reversed    ?? false;
    strip.patternId   = strip.patternId   ?? null;
    if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    if (strip.offsetX || strip.offsetY) {
      const ox = strip.offsetX || 0, oy = strip.offsetY || 0;
      strip.pixels.forEach(px => { px.x += ox; px.y += oy; });
    }
    state.strips.push(strip);
    state.stripTimes.set(strip.id, { t: 0, time: 0 });
  });
  assignIndices(state.strips);

  // Merge custom patterns on top of library
  if (data.customPatterns?.length) {
    state.patterns = [...PATTERNS, ...data.customPatterns];
  }

  if (data.activePatternId) state.activePatternId = data.activePatternId;

  if (Array.isArray(data.palette) && data.palette.length === 6) {
    state.palette = data.palette;
    state.palette.forEach((hex, i) => {
      const sw = document.getElementById(`pal-${i}`);
      if (sw) /** @type {HTMLInputElement} */ (sw).value = hex;
    });
  }
  if (data.bpm) {
    state.bpm = data.bpm;
    const el = document.getElementById('bpm-input');
    if (el) /** @type {HTMLInputElement} */ (el).value = String(state.bpm);
    document.documentElement.style.setProperty('--bpm-interval', `${Math.round(60000 / state.bpm)}ms`);
  }
  if (Array.isArray(data.scenes))  state.scenes      = data.scenes;
  if (data.activeSceneId)          state.activeSceneId = data.activeSceneId;
  if (data.patternParams)          state.patternParams = data.patternParams;
  if (Array.isArray(data.groups))  state.groups       = data.groups;
  if (Array.isArray(data.artworkLayerState)) state.artworkLayerState = data.artworkLayerState;

  const _setSlider = (id, valId, raw, fmt) => {
    const el = document.getElementById(id), valEl = document.getElementById(valId);
    if (el)    /** @type {HTMLInputElement} */ (el).value = String(raw);
    if (valEl) valEl.textContent = fmt(raw);
  };
  if (data.masterSpeed != null) {
    state.masterSpeed = data.masterSpeed;
    _setSlider('master-speed', 'master-speed-val', Math.round(state.masterSpeed * 100), v => (v / 100).toFixed(2) + '×');
  }
  if (data.masterBrightness != null) {
    state.masterBrightness = data.masterBrightness;
    _setSlider('master-brightness', 'master-brightness-val', Math.round(state.masterBrightness * 100), v => v + '%');
  }
  if (data.masterSaturation != null) {
    state.masterSaturation = data.masterSaturation;
    _setSlider('master-saturation', 'master-saturation-val', Math.round(state.masterSaturation * 100), v => v + '%');
  }
  if (data.gammaEnabled != null) {
    state.gammaEnabled = data.gammaEnabled;
    const cb = document.getElementById('gamma-enabled');
    if (cb) /** @type {HTMLInputElement} */ (cb).checked = state.gammaEnabled;
  }
  if (data.gammaValue != null) {
    state.gammaValue = data.gammaValue;
    const sel = document.getElementById('gamma-value');
    if (sel) /** @type {HTMLSelectElement} */ (sel).value = String(state.gammaValue);
  }
  if (data.ledTypeId) {
    state.ledTypeId = data.ledTypeId;
    const sel = document.getElementById('global-led-type');
    if (sel) /** @type {HTMLSelectElement} */ (sel).value = state.ledTypeId;
    _updateInspectorDensities();
  }
  if (data.wledIp) {
    state.wledIp = data.wledIp;
    const el = document.getElementById('wled-ip');
    if (el) /** @type {HTMLInputElement} */ (el).value = state.wledIp;
  }
  if (data.crossfadeDuration != null) {
    state.crossfadeDuration = data.crossfadeDuration;
    _setSlider('crossfade-duration', 'crossfade-duration-val', state.crossfadeDuration, v => (v / 1000).toFixed(1) + 's');
  }

  _rebuildNorm();
  state.strips.forEach(s => canvasManager.setStripDots(s.id, s.pixels));
  if (Array.isArray(data.connections)) {
    state.connections = data.connections;
    _buildChainMap();
    canvasManager.renderConnections(state.connections);
  }
}

// ── SVG Import Modal ──────────────────────────────────────────────────────

let _pendingLayers = [];

function showImportModal(layers) {
  _pendingLayers = layers;

  const pitch   = _getPitch();
  const pxPerMm = _getPxPerMm();

  document.getElementById('modal-pitch-val').textContent    = pitch;
  document.getElementById('modal-scale-val').textContent    = pxPerMm.toFixed(4);
  document.getElementById('modal-section-count').textContent = layers.length;

  _buildImportTable(layers, pitch, pxPerMm);
  document.getElementById('import-modal').classList.remove('hidden');
}

function _buildImportTable(layers, pitch, pxPerMm) {
  const tbody = document.getElementById('import-tbody');
  tbody.innerHTML = '';

  layers.forEach((layer, i) => {
    const lenMm   = layer.svgLength / pxPerMm;
    const autoLED = Math.max(1, Math.round(lenMm / pitch));
    layer._autoLED = autoLED;

    // Pre-assign the color so the user sees it in the table
    layer._color = layer._color ?? canvasManager.nextColor();

    const hasPaths = layer.pathData && layer.pathData.trim().length > 0;
    const lenStr   = hasPaths ? `${_fmtMm(lenMm)}` : '—';
    const autoStr  = hasPaths ? String(autoLED) : '—';
    const warnNote = hasPaths ? '' : '<span title="No path elements found in this layer" style="color:var(--warn)">⚠ no paths</span>';

    const tr = document.createElement('tr');
    tr.dataset.idx = i;
    tr.innerHTML = `
      <td>
        <input type="checkbox" class="import-check" ${hasPaths ? 'checked' : ''}
               ${hasPaths ? '' : 'disabled'} />
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${layer._color}"></span>
          <input type="text" class="import-name" value="${_escHtml(layer.name)}" />
          ${warnNote}
        </div>
      </td>
      <td class="import-num">${lenStr}</td>
      <td class="import-num hi">${autoStr}</td>
      <td><input type="number" class="import-override" value="${hasPaths ? autoLED : 0}"
                 min="1" max="4096" ${hasPaths ? '' : 'disabled'} /></td>
    `;

    tr.querySelector('.import-check')?.addEventListener('change', _updateModalTotal);
    tr.querySelector('.import-override')?.addEventListener('input',  _updateModalTotal);
    tbody.appendChild(tr);
  });

  _updateModalTotal();
}

function _updateModalTotal() {
  let total = 0;
  document.querySelectorAll('#import-tbody tr').forEach(row => {
    const check = row.querySelector('.import-check');
    if (check?.checked) total += parseInt(row.querySelector('.import-override').value) || 0;
  });
  document.getElementById('modal-total-leds').textContent = total;
}

function _closeImportModal() {
  document.getElementById('import-modal').classList.add('hidden');
  _pendingLayers = [];
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// (Import modal removed — SVG import now goes directly to layer inspector)

// ── Feature 15: Pattern library export/import ─────────────────────────────

function _exportCurrentPattern() {
  _saveEditorToPattern();
  const p = _activePattern();
  if (!p) return;
  const data = { ledPatternVersion: 1, name: p.name, code: p.code };
  download(JSON.stringify(data, null, 2), `${p.name.replace(/\s+/g, '-').toLowerCase()}.led-pattern.json`);
  showToast(`Exported "${p.name}"`, 'ok');
}

function _importPattern() {
  const input = Object.assign(document.createElement('input'), {
    type: 'file', accept: '.json'
  });
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.ledPatternVersion || !data.code) throw new Error('Not a pattern file');
      const p = { id: crypto.randomUUID(), name: data.name || 'Imported', code: data.code };
      state.patterns.push(p);
      state.activePatternId = p.id;
      renderPatternSelect();
      renderPatternCards();
      renderStripsList();
      showToast(`Imported "${p.name}"`, 'ok');
    } catch {
      showToast('Invalid pattern file', 'warn');
    }
  };
  input.click();
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  const tag = /** @type {HTMLElement} */ (e.target).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (/** @type {HTMLElement} */ (e.target).closest('.cm-editor, .modal')) return;

  if (e.key === 'Escape') {
    if (state.inspectorLayerId != null) {
      _hideInspector(); return;
    }
    canvasManager.deselectAll();
    return;
  }

  // Space: hold to pan canvas (tap with no drag = play/stop)
  if (e.key === ' ') {
    e.preventDefault();
    if (!state.spaceHeld) {
      state.spaceHeld = true;
      state.spaceDragged = false;
      wrapper.classList.add('space-pan');
    }
    return;
  }

  // Undo / Redo
  const _mod = e.metaKey || e.ctrlKey;
  if (_mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (_mod && e.key === 'z' &&  e.shiftKey) { e.preventDefault(); redo(); return; }
  if (_mod && e.key === 'y')                { e.preventDefault(); redo(); return; }

  switch (e.key.toUpperCase()) {
    case 'S': _setTool('select'); break;
    case 'X': _setTool('delete'); break;
    case 'P':
      if (state.animating) stopAnim(); else _compileAndRun();
      break;
  }

  if (e.key === 'g' || e.key === 'G') {
    if (state.selectedIds.size >= 2) {
      document.getElementById('btn-group-selected')?.click();
    }
  }
});

// Unsaved-changes guard
let _isDirty = false;
function _markDirty() { _isDirty = true; }
window.addEventListener('beforeunload', e => {
  if (_isDirty && (state.strips.length || state.patterns.length > 9)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('keyup', e => {
  if (e.key === ' ') {
    const wasDragged = state.spaceDragged;
    state.spaceHeld  = false;
    state.spaceDragged = false;
    wrapper.classList.remove('space-pan');
    if (!wasDragged) {
      // Quick tap without drag = play/stop
      if (state.animating) stopAnim(); else _compileAndRun();
    }
  }
});

function _setTool(tool) {
  document.querySelectorAll('.tool').forEach(b => b.classList.remove('active'));
  document.getElementById(`tool-${tool}`)?.classList.add('active');
  canvasManager.setTool(tool);
  document.getElementById('status-mode').textContent = `Tool: ${tool}`;
}

function _switchTab(name) {
  const tabToMode = { strips: 'layout', pattern: 'pattern', export: 'export', flash: 'flash' };
  const mode = tabToMode[name] || 'layout';
  document.body.dataset.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
  if (name === 'pattern') {
    const details = document.getElementById('code-editor-details');
    if (details) details.open = true;
  }
}

// ── Layer Inspector ───────────────────────────────────────────────────────

function _initInspector() {
  // Populate the global LED type selector (project-level setting)
  const globalTypeEl  = document.getElementById('global-led-type');
  const emptyTypeEl   = document.getElementById('empty-led-type');
  const emptyDensEl   = document.getElementById('empty-density');
  const panelDensEl   = document.getElementById('default-density');

  [globalTypeEl, emptyTypeEl].forEach(sel => {
    if (!sel) return;
    LED_TYPES.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.name;
      if (t.id === state.ledTypeId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      state.ledTypeId = sel.value;
      [globalTypeEl, emptyTypeEl].forEach(s => { if (s && s !== sel) s.value = sel.value; });
      _updateInspectorDensities();
      _recalcInspectorCount();
    });
  });

  if (emptyDensEl) {
    emptyDensEl.addEventListener('change', () => {
      if (panelDensEl) { panelDensEl.value = emptyDensEl.value; panelDensEl.dispatchEvent(new Event('change')); }
    });
  }
  if (panelDensEl) {
    panelDensEl.addEventListener('change', () => {
      if (emptyDensEl) emptyDensEl.value = panelDensEl.value;
    });
  }

  _updateInspectorDensities();
}

function _updateInspectorDensities() {
  const ledType = LED_TYPES.find(t => t.id === state.ledTypeId) ?? LED_TYPES[0];
  const densEl  = document.getElementById('inspector-density');
  if (!densEl) return;
  densEl.innerHTML = '';
  const customRow = document.getElementById('inspector-custom-row');

  if (ledType.densities.length) {
    ledType.densities.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = `${d} LEDs/m  (${(1000/d).toFixed(1)} mm pitch)`;
      if (d === 60) opt.selected = true;
      densEl.appendChild(opt);
    });
    const customOpt = document.createElement('option');
    customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
    densEl.appendChild(customOpt);
    if (customRow) customRow.style.display = 'none';
  } else {
    const opt = document.createElement('option');
    opt.value = 'custom'; opt.textContent = 'Custom';
    densEl.appendChild(opt);
    if (customRow) customRow.style.display = '';
  }
}

function _getInspectorDensity() {
  const val = document.getElementById('inspector-density')?.value;
  if (val === 'custom') {
    return parseInt(document.getElementById('inspector-custom-density')?.value ?? '60', 10) || 60;
  }
  return parseInt(val ?? '60', 10) || 60;
}

function _recalcInspectorCount() {
  const layer = state.artworkLayers.find(l => l.layerId === state.inspectorLayerId);
  if (!layer?.svgLength) return;
  const density  = _getInspectorDensity();
  const pxPerMm  = _getPxPerMm();
  const autoCount = Math.max(1, Math.round(layer.svgLength * density / (pxPerMm * 1000)));
  const countEl   = document.getElementById('inspector-led-count');
  const noteEl    = document.getElementById('inspector-count-note');
  if (countEl) countEl.value = String(autoCount);
  if (noteEl)  noteEl.textContent = `auto · ${density}/m`;
}

function _toggleArtworkLayerVisible(layer) {
  layer._hidden = !layer._hidden;
  const visible = !layer._hidden;
  canvasManager.setArtworkLayerVisible(layer.layerId, visible);
  // Mirror to the LED strip if one exists for this layer
  const strip = state.strips.find(s => s.layerId === layer.layerId);
  if (strip && strip.visible !== visible) {
    canvasManager.toggleStripVisible(strip.id);
  }
  renderArtworkLayersList();
}

function _deleteArtworkLayer(layerId) {
  // Remove from SVG DOM
  const svgEl = canvasManager._findArtworkLayer?.(layerId);
  if (svgEl) svgEl.remove();
  else {
    const importedSvg = document.getElementById('imported-svg');
    const el = importedSvg?.querySelector(`#${CSS.escape(layerId)}`);
    if (el) el.remove();
  }
  // Remove from state
  state.artworkLayers = state.artworkLayers.filter(l => l.layerId !== layerId);
  state.layerOrder    = state.layerOrder.filter(o => o.id !== layerId);
  // Remove any strips linked to this layer
  const linkedIds = state.strips.filter(s => s.layerId === layerId).map(s => s.id);
  for (const id of linkedIds) canvasManager.deleteStrip(id);
  renderArtworkLayersList();
  _updateEmptyState();
  _markDirty();
}

// ── Drag-to-reorder state ─────────────────────────────────────────────────
let _dragSrcIdx = null;

function renderArtworkLayersList() {
  const section = document.getElementById('artwork-layers-section');
  const list    = document.getElementById('artwork-layers-list');
  const countEl = document.getElementById('artwork-layer-count');
  if (!section || !list) return;

  const realLayers = state.artworkLayers.filter(l => !l._isSubPath);
  const allItems   = state.layerOrder.length
    ? state.layerOrder
    : realLayers.map(l => ({ type: 'layer', id: l.layerId }));

  if (!realLayers.length && !state.layerGroups.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const totalPaths = realLayers.reduce((n, l) => n + (l.subPaths?.length || 1), 0);
  if (countEl) countEl.textContent = `${realLayers.length} layer${realLayers.length !== 1 ? 's' : ''} · ${totalPaths} paths`;

  // Header toggle-all
  const allVisBtn = document.getElementById('alr-toggle-all');
  if (allVisBtn) {
    const allVis = realLayers.every(l => !l._hidden) && realLayers.every(l => (l.subPaths||[]).every(sp => !sp._hidden));
    allVisBtn.textContent = allVis ? '● All' : '○ All';
    allVisBtn.dataset.mode = allVis ? 'hide' : 'show';
  }

  // Group button visibility
  const groupBtn = document.getElementById('alr-group-btn');
  if (groupBtn) groupBtn.classList.toggle('hidden', state.panelChecked.size < 2);

  list.innerHTML = '';

  allItems.forEach((orderItem, orderIdx) => {
    if (orderItem.type === 'group') {
      _renderGroupRow(list, orderItem.id, orderIdx);
    } else {
      const layer = realLayers.find(l => l.layerId === orderItem.id);
      if (layer) _renderLayerRow(list, layer, orderIdx);
    }
  });
}

function _renderLayerRow(list, layer, orderIdx) {
  const subPaths  = layer.subPaths ?? [];
  const hasChildren = subPaths.length > 1;
  const expanded  = layer._expanded === true;
  const hidden    = !!layer._hidden;
  const color     = layer._color ?? '#888';
  const existing  = state.strips.find(s => s.layerId === layer.layerId);
  const lenMm     = layer.svgLength ? Math.round(layer.svgLength / _getPxPerMm()) : 0;

  const li = document.createElement('li');
  li.className = ['alr-row', 'alr-layer', hidden ? 'alr-hidden' : '', existing ? 'alr-configured' : ''].filter(Boolean).join(' ');
  li.draggable = true;
  li.dataset.orderIdx = orderIdx;
  li.dataset.layerId  = layer.layerId;

  // Drag handle
  const handle = document.createElement('span');
  handle.className = 'alr-handle';
  handle.textContent = '⠿';
  handle.title = 'Drag to reorder';

  // Chevron
  const chev = document.createElement('button');
  chev.className = 'alr-chevron';
  chev.textContent = hasChildren ? (expanded ? '▾' : '▸') : ' ';
  chev.style.visibility = hasChildren ? '' : 'hidden';
  chev.addEventListener('click', e => {
    e.stopPropagation();
    layer._expanded = !expanded;
    renderArtworkLayersList();
  });

  // Eye
  const eye = document.createElement('button');
  eye.className = 'alr-eye';
  eye.title = hidden ? 'Show' : 'Hide';
  eye.textContent = hidden ? '○' : '●';
  eye.style.color = hidden ? 'var(--dim)' : color;
  eye.addEventListener('click', e => {
    e.stopPropagation();
    _toggleArtworkLayerVisible(layer);
  });

  // Color swatch
  const swatch = document.createElement('span');
  swatch.className = 'alr-swatch';
  swatch.style.background = color;
  swatch.title = 'Layer color';

  // Name (double-click to rename)
  const nameEl = document.createElement('span');
  nameEl.className = 'alr-name';
  nameEl.textContent = layer.name;
  nameEl.title = 'Double-click to rename';
  nameEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    _inlineRename(nameEl, v => { layer.name = v; renderArtworkLayersList(); });
  });

  // Right meta
  const meta = document.createElement('span');
  meta.className = 'alr-meta';
  if (lenMm) meta.innerHTML = `<span class="alr-len">${_fmtMm(lenMm)}</span>`;

  // Delete layer button
  const delBtn = document.createElement('button');
  delBtn.className = 'alr-delete btn-icon';
  delBtn.textContent = '×';
  delBtn.title = 'Delete layer';
  delBtn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!await showConfirm(`Delete layer "${layer.name}"?`)) return;
    _deleteArtworkLayer(layer.layerId);
  });

  li.append(handle, chev, eye, swatch, nameEl, meta, delBtn);

  // Layer-level click → inspector
  li.addEventListener('click', () => { if (!hidden) _showInspector(layer); });
  li.addEventListener('mouseenter', () => { if (!hidden) canvasManager.setLayerHighlight(layer.layerId); });
  li.addEventListener('mouseleave', () => canvasManager.clearLayerHighlight());

  // Drag events
  _attachDragEvents(li, orderIdx);

  list.appendChild(li);

  // Sub-path rows (when expanded)
  if (hasChildren && expanded) {
    subPaths.forEach((sp, i) => _renderSubPathRow(list, layer, sp, i));
  }
}

function _renderSubPathRow(list, layer, sp, spIdx) {
  const hidden  = !!sp._hidden;
  const checked = state.panelChecked.has(sp.pathId);
  const spLenMm = sp.svgLength ? Math.round(sp.svgLength / _getPxPerMm()) : 0;
  const inGroup = state.layerGroups.some(g => g.members.some(m => m.subPath.pathId === sp.pathId));

  const li = document.createElement('li');
  li.className = ['alr-row', 'alr-subpath', hidden ? 'alr-hidden' : '', checked ? 'alr-checked' : '', inGroup ? 'alr-in-group' : ''].filter(Boolean).join(' ');
  li.dataset.pathId = sp.pathId;

  // Indent spacer
  const indent = document.createElement('span');
  indent.className = 'alr-indent';

  // Checkbox
  const cb = document.createElement('button');
  cb.className = 'alr-checkbox';
  cb.title = checked ? 'Deselect' : 'Select for grouping';
  cb.textContent = checked ? '☑' : '☐';
  cb.addEventListener('click', e => {
    e.stopPropagation();
    if (state.panelChecked.has(sp.pathId)) {
      state.panelChecked.delete(sp.pathId);
    } else {
      state.panelChecked.add(sp.pathId);
    }
    renderArtworkLayersList();
  });

  // Eye
  const eye = document.createElement('button');
  eye.className = 'alr-eye';
  eye.title = hidden ? 'Show path' : 'Hide path';
  eye.textContent = hidden ? '○' : '●';
  eye.addEventListener('click', e => {
    e.stopPropagation();
    sp._hidden = !sp._hidden;
    canvasManager.setSubPathVisible(sp, !sp._hidden);
    renderArtworkLayersList();
  });

  // Number badge
  const num = document.createElement('span');
  num.className = 'alr-subpath-num';
  num.textContent = String(spIdx + 1);

  // Name
  const nameEl = document.createElement('span');
  nameEl.className = 'alr-name';
  nameEl.textContent = sp.name;
  nameEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    _inlineRename(nameEl, v => { sp.name = v; renderArtworkLayersList(); });
  });

  // Length
  const lenEl = document.createElement('span');
  lenEl.className = 'alr-len alr-len-right';
  lenEl.textContent = spLenMm ? `${_fmtMm(spLenMm)} mm` : '';

  li.append(indent, cb, eye, num, nameEl, lenEl);

  li.addEventListener('click', () => {
    if (hidden) return;
    canvasManager.selectPath(layer, sp, false);
  });

  list.appendChild(li);
}

function _renderGroupRow(list, groupId, orderIdx) {
  const group = state.layerGroups.find(g => g.groupId === groupId);
  if (!group) return;
  const expanded = group._expanded !== false;
  const hidden   = !!group._hidden;

  const li = document.createElement('li');
  li.className = ['alr-row', 'alr-group', hidden ? 'alr-hidden' : ''].filter(Boolean).join(' ');
  li.draggable = true;
  li.dataset.orderIdx = orderIdx;
  li.dataset.groupId  = groupId;

  const handle = document.createElement('span');
  handle.className = 'alr-handle';
  handle.textContent = '⠿';

  const chev = document.createElement('button');
  chev.className = 'alr-chevron';
  chev.textContent = expanded ? '▾' : '▸';
  chev.addEventListener('click', e => {
    e.stopPropagation();
    group._expanded = !expanded;
    renderArtworkLayersList();
  });

  const eye = document.createElement('button');
  eye.className = 'alr-eye';
  eye.textContent = hidden ? '○' : '●';
  eye.style.color = hidden ? 'var(--dim)' : '#f7c59f';
  eye.addEventListener('click', e => {
    e.stopPropagation();
    group._hidden = !group._hidden;
    group.members.forEach(({ subPath }) => {
      subPath._hidden = group._hidden;
      canvasManager.setSubPathVisible(subPath, !group._hidden);
    });
    renderArtworkLayersList();
  });

  const icon = document.createElement('span');
  icon.className = 'alr-group-icon';
  icon.textContent = '⊞';

  const nameEl = document.createElement('span');
  nameEl.className = 'alr-name';
  nameEl.textContent = group.name;
  nameEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    _inlineRename(nameEl, v => { group.name = v; renderArtworkLayersList(); });
  });

  const count = document.createElement('span');
  count.className = 'alr-len';
  count.textContent = `${group.members.length} paths`;

  const del = document.createElement('button');
  del.className = 'alr-del-btn';
  del.title = 'Ungroup';
  del.textContent = '⊠';
  del.addEventListener('click', e => {
    e.stopPropagation();
    _deleteGroup(groupId);
  });

  li.append(handle, chev, eye, icon, nameEl, count, del);
  _attachDragEvents(li, orderIdx);
  list.appendChild(li);

  if (expanded) {
    group.members.forEach(({ layer, subPath }, mi) => {
      const hidden  = !!subPath._hidden;
      const spLenMm = subPath.svgLength ? Math.round(subPath.svgLength / _getPxPerMm()) : 0;

      const mLi = document.createElement('li');
      mLi.className = ['alr-row', 'alr-subpath', 'alr-group-member', hidden ? 'alr-hidden' : ''].filter(Boolean).join(' ');

      const indent = document.createElement('span');
      indent.className = 'alr-indent';

      const orderNum = document.createElement('span');
      orderNum.className = 'alr-subpath-num';
      orderNum.textContent = String(mi + 1);

      // Move up / down
      const up = document.createElement('button');
      up.className = 'alr-move-btn';
      up.textContent = '↑';
      up.disabled = mi === 0;
      up.addEventListener('click', e => { e.stopPropagation(); _moveGroupMember(groupId, mi, mi - 1); });

      const dn = document.createElement('button');
      dn.className = 'alr-move-btn';
      dn.textContent = '↓';
      dn.disabled = mi === group.members.length - 1;
      dn.addEventListener('click', e => { e.stopPropagation(); _moveGroupMember(groupId, mi, mi + 1); });

      const nameEl = document.createElement('span');
      nameEl.className = 'alr-name';
      nameEl.textContent = `${layer.name} › ${subPath.name}`;

      const lenEl = document.createElement('span');
      lenEl.className = 'alr-len alr-len-right';
      lenEl.textContent = spLenMm ? `${_fmtMm(spLenMm)} mm` : '';

      const rm = document.createElement('button');
      rm.className = 'alr-del-btn';
      rm.title = 'Remove from group';
      rm.textContent = '✕';
      rm.addEventListener('click', e => {
        e.stopPropagation();
        group.members.splice(mi, 1);
        if (!group.members.length) _deleteGroup(groupId);
        else renderArtworkLayersList();
      });

      mLi.append(indent, orderNum, up, dn, nameEl, lenEl, rm);
      mLi.addEventListener('click', () => { if (!hidden) canvasManager.selectPath(layer, subPath, false); });
      list.appendChild(mLi);
    });

    // "Add as strip" action row for group
    const actLi = document.createElement('li');
    actLi.className = 'alr-row alr-group-action';
    const addBtn = document.createElement('button');
    addBtn.className = 'alr-group-add-btn';
    addBtn.textContent = '+ Add group as strip';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      _addGroupAsStrip(group);
    });
    actLi.appendChild(addBtn);
    list.appendChild(actLi);
  }
}

function _attachDragEvents(el, orderIdx) {
  el.addEventListener('dragstart', e => {
    _dragSrcIdx = orderIdx;
    el.classList.add('alr-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => el.classList.remove('alr-dragging'));
  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('alr-drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('alr-drag-over'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('alr-drag-over');
    if (_dragSrcIdx === null || _dragSrcIdx === orderIdx) return;
    const order = [...state.layerOrder];
    const [moved] = order.splice(_dragSrcIdx, 1);
    order.splice(orderIdx, 0, moved);
    state.layerOrder = order;
    _dragSrcIdx = null;
    renderArtworkLayersList();
  });
}

function _inlineRename(el, onConfirm) {
  const old = el.textContent;
  const inp = document.createElement('input');
  inp.value = old;
  inp.className = 'alr-rename-input';
  el.replaceWith(inp);
  inp.focus();
  inp.select();
  const commit = () => {
    const val = inp.value.trim() || old;
    onConfirm(val);
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { inp.replaceWith(el); }
  });
}

function _createGroup(name) {
  const members = [];
  state.panelChecked.forEach(pathId => {
    for (const layer of state.artworkLayers.filter(l => !l._isSubPath)) {
      const sp = (layer.subPaths || []).find(s => s.pathId === pathId);
      if (sp) { members.push({ layer, subPath: sp }); break; }
    }
  });
  if (members.length < 2) return;
  const groupId = crypto.randomUUID();
  const group = { groupId, name, _hidden: false, _expanded: true, members };
  state.layerGroups.push(group);
  state.layerOrder.unshift({ type: 'group', id: groupId });
  state.panelChecked.clear();
  renderArtworkLayersList();
  showToast(`Group "${name}" created with ${members.length} paths`, 'ok');
}

function _deleteGroup(groupId) {
  state.layerGroups = state.layerGroups.filter(g => g.groupId !== groupId);
  state.layerOrder  = state.layerOrder.filter(o => !(o.type === 'group' && o.id === groupId));
  renderArtworkLayersList();
}

function _moveGroupMember(groupId, fromIdx, toIdx) {
  const group = state.layerGroups.find(g => g.groupId === groupId);
  if (!group) return;
  const [m] = group.members.splice(fromIdx, 1);
  group.members.splice(toIdx, 0, m);
  // Sync canvas reorder
  canvasManager.reorderSelection(fromIdx, toIdx);
  renderArtworkLayersList();
}

function _addGroupAsStrip(group) {
  if (!group.members.length) return;
  const pathData  = group.members.map(m => m.subPath.pathData).join(' ');
  const svgLength = group.members.reduce((s, m) => s + (m.subPath.svgLength || 0), 0);
  const density   = _getPitch() > 0 ? 1000 / _getPitch() : 60;
  const pixelCount = Math.max(1, Math.round(svgLength * density / (_getPxPerMm() * 1000)));
  const strip = {
    id: crypto.randomUUID(), name: group.name, pathData, pixelCount, svgLength,
    layerId: null, color: canvasManager.nextColor(),
    visible: true, speed: 1.0, brightness: 1.0, hueShift: 0, reversed: false, patternId: null,
  };
  canvasManager.addStrip(strip);
  const pathEl = canvasManager.getPathEl(strip.id);
  strip.pixels = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
  state.strips.push(strip);
  state.stripTimes.set(strip.id, { t: 0, time: 0 });
  canvasManager.setStripDots(strip.id, strip.pixels);
  _reindex(); _rebuildNorm();
  renderStripsList(); syncExportInfo(); _updateEmptyState();
  showToast(`Added "${group.name}" · ${pixelCount} LEDs`, 'ok');
}

function _showInspector(layer) {
  state.inspectorLayerId = layer.layerId;
  document.querySelectorAll('.alr-layer').forEach(row =>
    row.classList.toggle('alr-inspector-open', row.dataset.layerId === layer.layerId)
  );

  const panel   = document.getElementById('layer-inspector');
  const nameEl  = document.getElementById('inspector-name');
  const lenEl   = document.getElementById('inspector-length');
  const countEl = document.getElementById('inspector-led-count');
  const addBtn  = document.getElementById('inspector-add-btn');
  const remBtn  = document.getElementById('inspector-remove-btn');
  if (!panel) return;

  nameEl.value = layer.name;

  const pxPerMm = _getPxPerMm();
  const lenMm   = layer.svgLength ? Math.round(layer.svgLength / pxPerMm) : 0;
  lenEl.textContent = lenMm ? `${_fmtMm(lenMm)} mm` : '—';

  _recalcInspectorCount();

  const existing = state.strips.find(s => s.layerId === layer.layerId);
  if (existing) {
    countEl.value = String(existing.pixelCount);
    addBtn.textContent = '↺ Update Strip';
    remBtn.style.display = '';
  } else {
    addBtn.textContent = '+ Add Strip';
    remBtn.style.display = 'none';
  }

  // Show sub-path context hint
  const hintEl = document.getElementById('inspector-subpath-hint');
  if (hintEl) {
    hintEl.textContent = layer._isSubPath ? `From: ${layer.name.split(' › ')[0]}` : '';
    hintEl.style.display = layer._isSubPath ? '' : 'none';
  }

  panel.classList.remove('hidden');
  _switchTab('strips');
}

function _hideInspector() {
  state.inspectorLayerId = null;
  document.getElementById('layer-inspector')?.classList.add('hidden');
  document.querySelectorAll('.alr-layer.alr-inspector-open').forEach(row =>
    row.classList.remove('alr-inspector-open')
  );
}

function _renderPathSelectionPanel() {
  const panel  = document.getElementById('path-selection-panel');
  const list   = document.getElementById('path-sel-list');
  const nameIn = document.getElementById('path-sel-name');
  if (!panel || !list) return;

  const sel = state.pathSelection;
  if (!sel.length) {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');

  list.innerHTML = '';
  sel.forEach(({ layer, subPath }, i) => {
    const li = document.createElement('li');
    li.className = 'path-sel-item';
    li.dataset.pathId = subPath.pathId;

    const order = document.createElement('span');
    order.className = 'path-sel-order';
    order.textContent = String(i + 1);

    const nameSp = document.createElement('span');
    nameSp.className = 'path-sel-name-label';
    nameSp.textContent = `${layer.name} › ${subPath.name}`;

    const lenMm = subPath.svgLength ? Math.round(subPath.svgLength / _getPxPerMm()) : 0;
    const lenSp = document.createElement('span');
    lenSp.className = 'path-sel-len';
    lenSp.textContent = lenMm ? `${_fmtMm(lenMm)} mm` : '';

    const moveUp = document.createElement('button');
    moveUp.className = 'path-sel-move';
    moveUp.textContent = '↑';
    moveUp.title = 'Move up';
    moveUp.disabled = i === 0;
    moveUp.addEventListener('click', () => {
      canvasManager.reorderSelection(i, i - 1);
    });

    const moveDown = document.createElement('button');
    moveDown.className = 'path-sel-move';
    moveDown.textContent = '↓';
    moveDown.title = 'Move down';
    moveDown.disabled = i === sel.length - 1;
    moveDown.addEventListener('click', () => {
      canvasManager.reorderSelection(i, i + 1);
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'path-sel-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from selection';
    removeBtn.addEventListener('click', () => {
      canvasManager.removeFromSelection(subPath.pathId);
    });

    li.append(order, nameSp, lenSp, moveUp, moveDown, removeBtn);
    list.appendChild(li);
  });

  // Auto-name from first path's layer if blank
  if (!nameIn.value) {
    nameIn.value = sel[0]?.layer.name ?? '';
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────

// Tool buttons
document.querySelectorAll('.tool').forEach(btn => {
  btn.addEventListener('click', () => _setTool(btn.id.replace('tool-', '')));
});

// Inspector — density change
document.getElementById('inspector-density')?.addEventListener('change', () => {
  const val = document.getElementById('inspector-density').value;
  const customRow = document.getElementById('inspector-custom-row');
  if (customRow) customRow.style.display = val === 'custom' ? '' : 'none';
  _recalcInspectorCount();
});
// Inspector — custom density input
document.getElementById('inspector-custom-density')?.addEventListener('input', _recalcInspectorCount);

// Inspector — Add / Update button
document.getElementById('inspector-add-btn')?.addEventListener('click', () => {
  const layerId = state.inspectorLayerId;
  const layer   = state.artworkLayers.find(l => l.layerId === layerId);
  if (!layer) return;

  const name       = document.getElementById('inspector-name').value.trim() || layer.name;
  const pixelCount = parseInt(document.getElementById('inspector-led-count').value, 10) || 1;
  const existingIdx = state.strips.findIndex(s => s.layerId === layerId);

  if (existingIdx >= 0) {
    const strip = state.strips[existingIdx];
    strip.name       = name;
    strip.pixelCount = pixelCount;
    const pathEl = canvasManager.getPathEl(strip.id);
    if (pathEl) {
      strip.pixels = samplePath(pathEl, pixelCount);
      if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
    }
    _reindex(); _rebuildNorm();
    canvasManager.setStripDots(strip.id, strip.pixels);
    canvasManager.renderConnections(state.connections);
    renderStripsList(); syncExportInfo(); renderArtworkLayersList();
    showToast(`Updated "${name}"`, 'ok');
  } else {
    const strip = {
      id:         crypto.randomUUID(),
      name,
      pathData:   layer.pathData,
      pixelCount,
      svgLength:  layer.svgLength,
      layerId,
      color:      canvasManager.nextColor(),
      visible:    true,
      speed:      1.0,
      brightness: 1.0,
      hueShift:   0,
      reversed:   false,
      patternId:  null,
    };
    canvasManager.addStrip(strip);
    const pathEl = canvasManager.getPathEl(strip.id);
    strip.pixels = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
    state.strips.push(strip);
    state.stripTimes.set(strip.id, { t: 0, time: 0 });
    canvasManager.setStripDots(strip.id, strip.pixels);
    _reindex(); _rebuildNorm();
    renderStripsList(); syncExportInfo(); _updateEmptyState(); renderArtworkLayersList();
    document.getElementById('inspector-add-btn').textContent = '↺ Update Strip';
    document.getElementById('inspector-remove-btn').style.display = '';
    showToast(`Added "${name}" · ${pixelCount} LEDs`, 'ok');
  }
});

// Inspector — Remove button
document.getElementById('inspector-remove-btn')?.addEventListener('click', () => {
  const layerId = state.inspectorLayerId;
  const strip   = state.strips.find(s => s.layerId === layerId);
  if (!strip) return;
  canvasManager.deleteStrip(strip.id);
  renderArtworkLayersList();
  document.getElementById('inspector-add-btn').textContent = '+ Add Strip';
  document.getElementById('inspector-remove-btn').style.display = 'none';
});

// Inspector — close button
document.getElementById('inspector-close-btn')?.addEventListener('click', _hideInspector);

// Path selection panel — clear
document.getElementById('path-sel-clear')?.addEventListener('click', () => {
  canvasManager.clearPathSelection();
  const nameIn = document.getElementById('path-sel-name');
  if (nameIn) nameIn.value = '';
});

// Path selection panel — Add as Strip
document.getElementById('path-sel-add')?.addEventListener('click', () => {
  const sel = state.pathSelection;
  if (!sel.length) return;
  const nameIn  = document.getElementById('path-sel-name');
  const name    = nameIn?.value.trim() || sel[0].layer.name;
  const pathData  = sel.map(s => s.subPath.pathData).join(' ');
  const svgLength = sel.reduce((sum, s) => sum + (s.subPath.svgLength || 0), 0);
  const density   = _getPitch() > 0 ? 1000 / _getPitch() : 60;
  const pixelCount = Math.max(1, Math.round(svgLength * density / (_getPxPerMm() * 1000)));

  const strip = {
    id:         crypto.randomUUID(),
    name,
    pathData,
    pixelCount,
    svgLength,
    layerId:    null,
    color:      canvasManager.nextColor(),
    visible:    true,
    speed:      1.0,
    brightness: 1.0,
    hueShift:   0,
    reversed:   false,
    patternId:  null,
  };
  canvasManager.addStrip(strip);
  const pathEl = canvasManager.getPathEl(strip.id);
  strip.pixels = pathEl ? samplePath(pathEl, strip.pixelCount) : [];
  state.strips.push(strip);
  state.stripTimes.set(strip.id, { t: 0, time: 0 });
  canvasManager.setStripDots(strip.id, strip.pixels);
  _reindex(); _rebuildNorm();
  renderStripsList(); syncExportInfo(); _updateEmptyState();
  canvasManager.clearPathSelection();
  if (nameIn) nameIn.value = '';
  showToast(`Added "${name}" · ${strip.pixelCount} LEDs from ${sel.length} path${sel.length !== 1 ? 's' : ''}`, 'ok');
});

// SVG import
document.getElementById('btn-load-svg').addEventListener('click', () =>
  document.getElementById('file-input').click());

document.getElementById('file-input').addEventListener('change', async e => {
  const file = /** @type {HTMLInputElement} */ (e.target).files[0];
  if (!file) return;
  await _handleFileImport(file);
  /** @type {HTMLInputElement} */ (e.target).value = '';
});

// Project
document.getElementById('btn-save').addEventListener('click', saveProject);
document.getElementById('btn-load').addEventListener('click', () => {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
  input.onchange = e => loadProject(/** @type {HTMLInputElement} */ (e.target).files[0]);
  input.click();
});

// Undo / Redo buttons
document.getElementById('btn-undo').addEventListener('click', () => undo());
document.getElementById('btn-redo').addEventListener('click', () => redo());

// Clear
document.getElementById('btn-clear-canvas').addEventListener('click', async () => {
  if (!await showConfirm('Clear all sections and reference artwork?')) return;
  canvasManager.clearCanvas();
  state.strips = [];
  state.groups = [];
  state.artworkLayers = [];
  state.pathSelection = [];
  state.stripTimes.clear();
  previewRenderer._frozenColorFn = null;
  previewRenderer.setViewBox(0, 0, 0, 0);
  _rebuildNorm();
  renderStripsList();
  renderArtworkLayersList();
  syncExportInfo();
  _updateEmptyState();
});

// Toggle preview
document.getElementById('btn-toggle-preview').addEventListener('click', e => {
  const on = previewRenderer.toggle();
  /** @type {HTMLButtonElement} */ (e.target).textContent = on ? 'Hide LEDs' : 'Show LEDs';
});

// Toggle dot mode (solid pixel colors vs glow)
document.getElementById('btn-toggle-dot-mode').addEventListener('click', e => {
  const btn = /** @type {HTMLButtonElement} */ (e.target);
  const mode = previewRenderer.cycleGlowMode();
  const labels = { center: '◉ Glow', outward: '◉ Out', inward: '◉ In', dots: '● Dots' };
  btn.textContent = labels[mode];
  btn.classList.toggle('active', mode !== 'center');
  btn.title = { center: 'Glow: symmetric bloom (click to cycle)', outward: 'Glow: outward from strip (click to cycle)', inward: 'Glow: inward to strip (click to cycle)', dots: 'Solid dots (click to cycle)' }[mode];
  const heatBtn = document.getElementById('btn-toggle-heatmap');
  if (heatBtn && heatBtn.classList.contains('active')) {
    previewRenderer.showCoverage(_coverageColorMap(), _coverageAngleMap());
  }
});

function _coverageColorMap() {
  return new Map(state.strips.map(s => [s.id, s.color]));
}

// Coverage heatmap — visualise LED density across the canvas
document.getElementById('btn-toggle-heatmap').addEventListener('click', e => {
  const btn = /** @type {HTMLButtonElement} */ (e.target);
  const isActive = btn.classList.toggle('active');
  if (!isActive) {
    previewRenderer.hideCoverage();
    previewRenderer.renderStatic();
    return;
  }
  if (!state.normalisedPixels.length) {
    btn.classList.remove('active');
    showToast('No LEDs mapped — draw or import sections first.', 'warn');
    return;
  }
  previewRenderer.showCoverage(_coverageColorMap(), _coverageAngleMap());
  showToast('Coverage — brighter areas have more overlap. Set direction on each strip with the compass. Click again to exit.');
});

document.getElementById('btn-toggle-directed').addEventListener('click', e => {
  const btn = /** @type {HTMLButtonElement} */ (e.target);
  const isActive = btn.classList.toggle('active');
  previewRenderer.setEmitAngles(_coverageAngleMap());
  previewRenderer.setDirectedMode(isActive);
  showToast(isActive ? 'Directed glow ON — bloom elongates in each strip\'s emit direction.' : 'Directed glow OFF.');
});

// Mode buttons (replaces old tab click handlers)
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const modeToTab = { layout: 'strips', pattern: 'pattern', export: 'export', flash: 'flash' };
    _switchTab(modeToTab[btn.dataset.mode]);
    if (btn.dataset.mode === 'export') refreshExportPreview();
  });
});

// Pattern controls
document.getElementById('pattern-select').addEventListener('change', e => {
  _saveEditorToPattern();
  state.activePatternId = /** @type {HTMLSelectElement} */ (e.target).value;
  _loadPatternIntoEditor();
  renderPatternCards();
});

document.getElementById('btn-new-pattern').addEventListener('click', async () => {
  const name = await showPrompt('Pattern name:', 'New Pattern');
  if (!name) return;
  const p = { id: crypto.randomUUID(), name, code: 'return hsv(fract(index / 60 + time), 1, 1);' };
  state.patterns.push(p);
  state.activePatternId = p.id;
  renderPatternSelect();
  renderPatternCards();
  renderStripsList(); // C1: update strip/group pattern dropdowns with new pattern
  _setEditorCode(p.code);
});

document.getElementById('btn-delete-pattern').addEventListener('click', () => {
  if (state.patterns.length <= 1) { showToast('Cannot delete the last pattern.', 'warn'); return; }
  const deletedId       = state.activePatternId;
  state.patterns        = state.patterns.filter(p => p.id !== deletedId);
  state.compiledFns.delete(deletedId);
  state.activePatternId = state.patterns[0].id;
  // C1: null out any strip/group that was using the deleted pattern
  state.strips.forEach(s => { if (s.patternId === deletedId) s.patternId = null; });
  state.groups.forEach(g => { if (g.patternId === deletedId) g.patternId = null; });
  renderStripsList();
  renderPatternSelect();
  renderPatternCards();
});

// Pattern tab play/stop buttons
document.getElementById('btn-play-cards')?.addEventListener('click', () => {
  if (state.animating) { stopAnim(); return; }
  if (!state.strips.length) { showToast('Add some LED sections first.', 'warn'); return; }
  _compileAndRun();
  startAnim();
});

document.getElementById('btn-run-pattern').addEventListener('click', _compileAndRun);
document.getElementById('btn-stop-pattern').addEventListener('click', stopAnim);

// Toolbar play/stop toggle
document.getElementById('btn-play-toolbar').addEventListener('click', () => {
  if (state.animating) { stopAnim(); return; }
  if (!state.compiledFns.size) {
    document.getElementById('btn-run-pattern').click();
  } else {
    startAnim();
  }
});

// Export
document.getElementById('btn-export-wled').addEventListener('click', () => {
  const pixels = getAllPixels(state.strips);
  if (!pixels.length) { showToast('No sections defined.', 'warn'); return; }
  download(toWLEDLedmap(pixels, _exportOpts()), 'ledmap.json');
});
document.getElementById('btn-export-fastled').addEventListener('click', () => {
  const pixels = getAllPixels(state.strips);
  if (!pixels.length) { showToast('No sections defined.', 'warn'); return; }
  download(toFastLED(pixels, _exportOpts()), 'ledmap.h', 'text/plain');
});
document.getElementById('btn-export-csv').addEventListener('click', () => {
  const pixels = getAllPixels(state.strips);
  if (!pixels.length) { showToast('No sections defined.', 'warn'); return; }
  download(toCSV(pixels), 'ledmap.csv', 'text/csv');
});

['export-normalize','export-scale-x','export-scale-y','export-offset-x','export-offset-y']
  .forEach(id => document.getElementById(id)?.addEventListener('change', () => {
    if (document.getElementById('tab-export').classList.contains('active')) refreshExportPreview();
  }));

// Dot size slider
document.getElementById('preview-scale').addEventListener('input', e => {
  const v = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
  // Map slider 1–10 → dot radius 6–20
  const dotR = 6 + (v - 1) * (14 / 9);
  previewRenderer.setDotRadius(dotR);
  const valEl = document.getElementById('preview-scale-val');
  if (valEl) valEl.textContent = String(v);
});

// Artwork opacity slider
canvasManager.setArtworkOpacity(0.5);

document.getElementById('preview-glow').addEventListener('input', e => {
  const raw  = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
  const mult = raw / 10;
  previewRenderer.setGlowAmount(mult);
  const valEl = document.getElementById('preview-glow-val');
  if (valEl) valEl.textContent = mult.toFixed(1) + '×';
});

// Default density ↔ pitch sync
const _densityEl = document.getElementById('default-density');
const _pitchEl   = document.getElementById('pitch');
if (_densityEl && _pitchEl) {
  _densityEl.addEventListener('change', () => {
    const d = parseInt(_densityEl.value, 10);
    if (d > 0) _pitchEl.value = (1000 / d).toFixed(2);
    if (state.strips.length) renderStripsList();
  });
  _pitchEl.addEventListener('change', () => {
    const mm = parseFloat(_pitchEl.value);
    if (mm > 0) {
      const nearest = [30, 60, 96, 144].reduce((a, b) =>
        Math.abs(1000 / b - mm) < Math.abs(1000 / a - mm) ? b : a
      );
      if (Math.abs(1000 / nearest - mm) < 2) _densityEl.value = String(nearest);
    }
    if (state.strips.length) renderStripsList();
  });
}

// Re-display lengths when scale changes
document.getElementById('px-per-mm')?.addEventListener('change', () => {
  if (state.strips.length) renderStripsList();
});

// Master speed slider
document.getElementById('master-speed').addEventListener('input', e => {
  const raw = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
  state.masterSpeed = raw / 100;
  document.getElementById('master-speed-val').textContent = state.masterSpeed.toFixed(2) + '×';
});

// Master brightness slider (A2)
document.getElementById('master-brightness').addEventListener('input', e => {
  const raw = parseFloat(/** @type {HTMLInputElement} */(e.target).value);
  state.masterBrightness = raw / 100;
  document.getElementById('master-brightness-val').textContent = raw + '%';
});

// Feature 6: Master saturation slider
document.getElementById('master-saturation')?.addEventListener('input', e => {
  const raw = parseFloat(e.target.value);
  state.masterSaturation = raw / 100;
  document.getElementById('master-saturation-val').textContent = Math.round(raw) + '%';
});

// Feature 7: Gamma correction
document.getElementById('gamma-enabled')?.addEventListener('change', e => {
  state.gammaEnabled = e.target.checked;
  _gammaLut = null; // invalidate cache
});
document.getElementById('gamma-value')?.addEventListener('change', e => {
  state.gammaValue = parseFloat(e.target.value) || 2.2;
  _gammaLut = null;
});

// B1: Palette swatches
for (let i = 0; i < 6; i++) {
  document.getElementById(`pal-${i}`)?.addEventListener('input', e => {
    state.palette[i] = /** @type {HTMLInputElement} */ (e.target).value;
  });
}

// B2: BPM input (manual) + tap tempo
document.getElementById('bpm-input')?.addEventListener('change', e => {
  const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
  // Feature 3: extended BPM range to 600
  if (!isNaN(v) && v >= 20 && v <= 600) {
    state.bpm = v;
    document.documentElement.style.setProperty('--bpm-interval', `${Math.round(60000 / v)}ms`);
  }
});

document.getElementById('btn-tap-bpm')?.addEventListener('click', () => {
  const now = Date.now();
  // BUG 3: discard stale taps before accumulating
  const TAP_EXPIRY_MS = 3000;
  state.tapTimes = state.tapTimes.filter(t => now - t < TAP_EXPIRY_MS);
  state.tapTimes.push(now);
  // Keep last 5 taps (gives up to 4 intervals)
  if (state.tapTimes.length > 5) state.tapTimes.shift();

  if (state.tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < state.tapTimes.length; i++) {
      intervals.push(state.tapTimes[i] - state.tapTimes[i - 1]);
    }
    // Median interval
    intervals.sort((a, b) => a - b);
    const mid = Math.floor(intervals.length / 2);
    const median = intervals.length % 2 === 0
      ? (intervals[mid - 1] + intervals[mid]) / 2
      : intervals[mid];
    state.bpm = Math.round(60000 / median);
    state.bpm = Math.max(20, Math.min(600, state.bpm));
    const bpmInput = document.getElementById('bpm-input');
    if (bpmInput) /** @type {HTMLInputElement} */ (bpmInput).value = String(state.bpm);
    document.documentElement.style.setProperty('--bpm-interval', `${Math.round(60000 / state.bpm)}ms`);
  }
  // Reset beat phase to the tap moment
  state.beatStart = state.t;

  // Feature 4: tap BPM visual flash
  const tapBtn = document.getElementById('btn-tap-bpm');
  tapBtn.classList.remove('tapped');
  void tapBtn.offsetWidth; // force reflow to restart animation
  tapBtn.classList.add('tapped');
});

// MIDI
document.getElementById('btn-midi-enable')?.addEventListener('click', _initMIDI);

document.getElementById('btn-midi-learn')?.addEventListener('click', () => {
  if (!state.midiAccess) { showToast('Connect MIDI first'); return; }
  state.midiLearn = !state.midiLearn;
  document.getElementById('btn-midi-learn')?.classList.toggle('active', state.midiLearn);
  if (state.midiLearn) {
    showToast('MIDI learn: move a controller, then click a slider to map it');
    // Next CC received will be mapped to the next interacted control
    state.midiLearnTarget = 'masterBrightness'; // default target until user clicks a control
  }
});

// B3: Scene save / recall / delete
document.getElementById('btn-save-scene')?.addEventListener('click', async () => {
  const name = await showPrompt('Scene name:', `Scene ${state.scenes.length + 1}`);
  if (!name) return;
  saveScene(name);
});

document.getElementById('scene-select')?.addEventListener('change', e => {
  const id = /** @type {HTMLSelectElement} */ (e.target).value;
  if (id) recallScene(id);
  else state.activeSceneId = null;
});

// Strips search filter
document.getElementById('strips-search')?.addEventListener('input', () => renderStripsList());

/// Artwork layers: group selected
document.getElementById('alr-group-btn')?.addEventListener('click', async () => {
  const name = await showPrompt('Group name:', 'Group');
  if (!name) return;
  _createGroup(name.trim() || 'Group');
});

// Artwork layers: show/hide all
document.getElementById('alr-toggle-all')?.addEventListener('click', e => {
  const btn = /** @type {HTMLElement} */ (e.target);
  const hide = btn.dataset.mode === 'hide';
  state.artworkLayers.filter(l => !l._isSubPath).forEach(layer => {
    layer._hidden = hide;
    canvasManager.setArtworkLayerVisible(layer.layerId, !hide);
    (layer.subPaths || []).forEach(sp => {
      sp._hidden = hide;
      canvasManager.setSubPathVisible(sp, !hide);
    });
  });
  renderArtworkLayersList();
});

document.getElementById('btn-delete-scene')?.addEventListener('click', () => {
  if (!state.activeSceneId) return;
  state.scenes = state.scenes.filter(s => s.id !== state.activeSceneId);
  state.activeSceneId = null;
  _renderSceneSelect();
});

// C2: WLED connect
document.getElementById('btn-wled-connect')?.addEventListener('click', _wledConnect);
document.getElementById('wled-ip')?.addEventListener('change', e => {
  state.wledIp = /** @type {HTMLInputElement} */ (e.target).value.trim();
});

// C3: New group button
document.getElementById('btn-new-group')?.addEventListener('click', async () => {
  const name = await showPrompt('Group name:', `Group ${state.groups.length + 1}`);
  if (!name) return;
  state.groups.push({
    id:         crypto.randomUUID(),
    name,
    collapsed:  false,
    stripIds:   [],
    speed:      null,
    brightness: null,
    hueShift:   null,
    visible:    true,
    patternId:  null,
    color:      canvasManager.nextColor(), // Feature 9
  });
  renderStripsList();
});

// Feature 11: Canvas zoom + pan event wiring
wrapper.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const rect = wrapper.getBoundingClientRect();
  _zoomCanvas(factor, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

wrapper.addEventListener('mousedown', e => {
  if (e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && state.spaceHeld)) {
    e.preventDefault();
    state.canvasPanning = true;
    if (state.spaceHeld) state.spaceDragged = true;
    wrapper.classList.add('panning');
  }
});
window.addEventListener('mousemove', e => {
  if (!state.canvasPanning) return;
  state.canvasPanX += e.movementX;
  state.canvasPanY += e.movementY;
  _applyCanvasTransform();
});
window.addEventListener('mouseup', e => {
  if (state.canvasPanning) {
    state.canvasPanning = false;
    wrapper.classList.remove('panning');
  }
});

document.getElementById('btn-zoom-in')?.addEventListener('click',    () => _zoomCanvas(1.25));
document.getElementById('btn-zoom-out')?.addEventListener('click',   () => _zoomCanvas(0.8));
document.getElementById('btn-zoom-reset')?.addEventListener('click', () => _resetZoom());

// Feature 12: LED hover tooltip
wrapper.addEventListener('mousemove', e => {
  if (!state.normalisedPixels.length) return;
  const rect = wrapper.getBoundingClientRect();
  // Account for zoom/pan transform
  const mx = (e.clientX - rect.left - state.canvasPanX) / state.canvasZoom;
  const my = (e.clientY - rect.top  - state.canvasPanY) / state.canvasZoom;

  // Find the SVG coordinate by scaling to viewBox
  const vb = svgEl.viewBox.baseVal;
  const svgX = mx / rect.width  * vb.width;
  const svgY = my / rect.height * vb.height;

  // Find nearest LED pixel
  let nearest = null, nearestDist = Infinity;
  for (const px of state.normalisedPixels) {
    const dx = px.x - svgX, dy = px.y - svgY;
    const d = dx*dx + dy*dy;
    if (d < nearestDist) { nearestDist = d; nearest = px; }
  }

  const tooltip = _getTooltip();
  // Threshold scales with zoom — closer zoom = tighter snap radius
  const threshold = (vb.width * 0.03 / state.canvasZoom) ** 2;
  if (nearest && nearestDist < threshold) {
    const strip = state.strips.find(s => s.id === nearest.stripId);
    tooltip.innerHTML = `<b>#${nearest.index}</b> · ${strip?.name ?? '?'}<br>x: ${nearest.nx.toFixed(3)}  y: ${nearest.ny.toFixed(3)}`;
    tooltip.classList.remove('hidden');
    // Prevent tooltip from overflowing right edge of viewport
    const tipX = e.clientX + 14;
    tooltip.style.left = (tipX + 140 > window.innerWidth ? e.clientX - 150 : tipX) + 'px';
    tooltip.style.top  = (e.clientY + 4) + 'px';
  } else {
    tooltip.classList.add('hidden');
  }
});
wrapper.addEventListener('mouseleave', () => _getTooltip().classList.add('hidden'));

// Feature 14: Crossfade duration slider
document.getElementById('crossfade-duration')?.addEventListener('input', e => {
  state.crossfadeDuration = parseInt(e.target.value, 10) || 0;
  document.getElementById('crossfade-duration-val').textContent =
    (state.crossfadeDuration / 1000).toFixed(1) + 's';
});

// Feature 15: Pattern library buttons
document.getElementById('btn-export-pattern')?.addEventListener('click', _exportCurrentPattern);
document.getElementById('btn-import-pattern')?.addEventListener('click', _importPattern);

// Effect Library
document.getElementById('btn-show-library')?.addEventListener('click', e => {
  const lib = document.getElementById('effect-library');
  const btn = /** @type {HTMLElement} */ (e.target);
  const open = lib?.classList.toggle('hidden');
  btn.classList.toggle('active', !open);
  if (!open) _renderEffectLibrary();
});
document.getElementById('btn-close-library')?.addEventListener('click', () => {
  document.getElementById('effect-library')?.classList.add('hidden');
  document.getElementById('btn-show-library')?.classList.remove('active');
});

// ── Empty-state onboarding ────────────────────────────────────────────────

// Shape template buttons
document.querySelectorAll('.shape-btn').forEach(btn => {
  btn.addEventListener('click', () => _startShapeTemplate(/** @type {HTMLElement} */ (btn).dataset.shape));
});

// Empty LED count slider display
document.getElementById('empty-leds')?.addEventListener('input', e => {
  const v = /** @type {HTMLInputElement} */ (e.target).value;
  document.getElementById('empty-leds-val').textContent = v;
});

// Empty drop-zone click + browse button → open file picker
const _openFilePicker = () => document.getElementById('file-input').click();
document.getElementById('empty-drop-zone')?.addEventListener('click', _openFilePicker);
document.getElementById('btn-empty-browse')?.addEventListener('click', e => {
  e.stopPropagation(); // prevent double-fire from drop-zone click
  _openFilePicker();
});

// Full-page drag-and-drop
let _dragCounter = 0;
document.addEventListener('dragenter', e => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  _dragCounter++;
  document.body.classList.add('drag-active');
});
document.addEventListener('dragleave', () => {
  _dragCounter = Math.max(0, _dragCounter - 1);
  if (_dragCounter === 0) document.body.classList.remove('drag-active');
});
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', async e => {
  e.preventDefault();
  _dragCounter = 0;
  document.body.classList.remove('drag-active');
  const file = e.dataTransfer?.files?.[0];
  if (file) await _handleFileImport(file);
});

// ── Strip popup event wiring ──────────────────────────────────────────────

document.getElementById('popup-pixels-input').addEventListener('change', e => {
  const inp = /** @type {HTMLInputElement} */ (e.target);
  const stripId = inp.dataset.stripId;
  const strip = state.strips.find(s => s.id === stripId);
  if (!strip) return;
  const n = Math.max(1, Math.min(4096, parseInt(inp.value) || 1));
  inp.value = String(n);
  strip.pixelCount = n;
  const pathEl = canvasManager.getPathEl(stripId);
  if (pathEl) {
    strip.pixels = samplePath(pathEl, n);
    if (strip.reversed) strip.pixels = strip.pixels.slice().reverse();
  }
  _reindex(); _rebuildNorm();
  canvasManager.setStripDots(stripId, strip.pixels);
  canvasManager.renderConnections(state.connections);
  renderStripsList(); syncExportInfo();
  _showStripPopup(strip); // reposition after pixel count change
});

document.getElementById('strip-popup-close').addEventListener('click', _hideStripPopup);
_initPopupDrag();

// Hide popup when clicking canvas (not on popup itself).
// Guard: don't close if a select inside the popup currently has focus
// (native dropdown option clicks may fire outside the popup's DOM tree).
wrapper.addEventListener('click', e => {
  if (e.target.closest('#strip-popup')) return;
  const popup = document.getElementById('strip-popup');
  if (popup && !popup.classList.contains('hidden') &&
      document.activeElement && popup.contains(document.activeElement)) return;
  _hideStripPopup();
});

// Multi-select: group selected
document.getElementById('btn-group-selected').addEventListener('click', () => {
  if (state.selectedIds.size < 2) return;
  const groupId = crypto.randomUUID();
  const group = {
    id:         groupId,
    name:       `Group ${state.groups.length + 1}`,
    stripIds:   Array.from(state.selectedIds),
    patternId:  null,
    hueShift:   0,
    brightness: 1.0,
  };
  state.groups.push(group);
  state.selectedIds.clear();
  _updateMultiSelectBar();
  document.querySelectorAll('#strips-list li.multi-selected').forEach(el => el.classList.remove('multi-selected'));
  renderStripsList();
  showToast(`Created "${group.name}" with ${group.stripIds.length} sections.`);
});

document.getElementById('btn-msel-clear').addEventListener('click', () => {
  state.selectedIds.clear();
  _updateMultiSelectBar();
  document.querySelectorAll('#strips-list li.multi-selected').forEach(el => el.classList.remove('multi-selected'));
});

// ── Boot ──────────────────────────────────────────────────────────────────

_lsRestore();
window.addEventListener('beforeunload', _lsSave);
setInterval(_lsSave, 60_000); // periodic backup every 60s

_setTool('select');
initEditor(state.patterns.find(p => p.id === state.activePatternId)?.code ?? '');
renderPatternSelect();
renderPatternCards();
renderParamSliders();
_renderSceneSelect();
syncExportInfo();
_updateEmptyState();
_updateScaleOverlay(); // Feature 13: initial scale overlay
_initInspector();
_updateUndoRedoUI();
initFlash();
// BPM CSS variable — initialise with default 120 BPM
document.documentElement.style.setProperty('--bpm-interval', `${Math.round(60000 / 120)}ms`);

// ── HMR — patterns-library.js hot-swaps without a page reload ────────────
if (import.meta.hot) {
  import.meta.hot.accept('./patterns-library.js', newMod => {
    if (!newMod) return;
    _LIBRARY_IDS.clear();
    newMod.PATTERNS.forEach(p => _LIBRARY_IDS.add(p.id));
    const customs = state.patterns.filter(p => !_LIBRARY_IDS.has(p.id));
    state.patterns = [...newMod.PATTERNS, ...customs];
    state.compiledFns.clear();
    _saveEditorToPattern();
    renderPatternSelect();
    renderPatternCards();
    renderParamSliders();
    showToast('Patterns updated', 'ok');
  });
}
