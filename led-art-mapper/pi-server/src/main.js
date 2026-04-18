/**
 * main.js — LED web interface for visitors + operator
 *
 * Boot sequence:
 *   1. Fetch /api/config → apply artist branding, get wledIp + scene list
 *   2. Fetch /api/ledmap → load into visualizer
 *   3. Build scene buttons
 *   4. Start animation loop
 *   5. Auto-connect to WLED via WebSocket
 *
 * View modes:
 *   'live'  — colours come from WLED WebSocket binary frames (default)
 *   'local' — local pattern rendering (fallback when WLED disconnected)
 *
 * The browser connects directly to WLED at config.wledIp for both HTTP
 * preset changes and the WebSocket live stream. WLED allows all origins
 * so no server proxy is needed.
 *
 * Features:
 *   1. Pattern parameter sliders (Feature 1)
 *   2. Color tint controls        (Feature 2)
 *   3. Audio reactive mode        (Feature 3)
 *   4. Sequence / autoplay        (Feature 4)
 *   5. WLED effects browser       (Feature 5)
 *   6. Operator code editor       (Feature 6)
 */

import { Visualizer }                                       from './visualizer.js';
import { WLEDClient }                                       from './wled.js';
import { SCENES, evalPixel, evalScene, runBeforeRender, setParam, detectParams, compile } from './patterns.js';
import { EditorView, basicSetup }                          from 'codemirror';
import { javascript }                                      from '@codemirror/lang-javascript';
import { oneDark }                                         from '@codemirror/theme-one-dark';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  config:      null,
  scenes:      [],       // merged: config list → pattern fns
  activeScene: null,

  viewMode:    'local',  // 'local' until WLED connects and sends a live frame

  // Animation
  animating: true,
  t:         0,
  time:      0,
  lastTs:    null,

  // WLED
  wled:       null,
  wledBri:    200,
  wledEffects: [],
  activeEffectId: null,

  // Feature 2 — tint
  tint: { h: 0, s: 1.0, v: 1.0, enabled: false },

  // Feature 3 — audio
  audio: {
    enabled:  false,
    context:  null,
    analyser: null,
    dataArray: null,
    bass: 0, mid: 0, treble: 0,
  },

  // Feature 4 — sequence
  sequence: {
    active:   false,
    interval: 30,
    idx:      0,
    _timer:   null,
  },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas       = /** @type {HTMLCanvasElement} */ (document.getElementById('main-canvas'));
const headerEl     = document.getElementById('artist-header');
const artistName   = document.getElementById('artist-name');
const pieceNameEl  = document.getElementById('piece-name');
const scenesRow    = document.getElementById('scenes-row');
const connDot      = document.getElementById('conn-dot');
const briSlider    = /** @type {HTMLInputElement} */ (document.getElementById('sl-bri'));
const briValEl     = document.getElementById('val-bri');
const paramsPanel  = document.getElementById('params-panel');
const tintPanel    = document.getElementById('tint-panel');

// Bottom strip buttons
const btnTint      = document.getElementById('btn-tint');
const btnAudio     = document.getElementById('btn-audio');
const audioMeter   = document.getElementById('audio-meter');
const meterBass    = document.getElementById('meter-bass');
const meterMid     = document.getElementById('meter-mid');
const meterTreble  = document.getElementById('meter-treble');
const btnSeq       = document.getElementById('btn-seq');
const seqInterval  = /** @type {HTMLSelectElement} */ (document.getElementById('seq-interval'));
const btnFx        = document.getElementById('btn-fx');
const btnEditor    = document.getElementById('btn-editor');

// Tint sliders
const tintHue      = /** @type {HTMLInputElement} */ (document.getElementById('tint-hue'));
const tintSat      = /** @type {HTMLInputElement} */ (document.getElementById('tint-sat'));
const tintBri      = /** @type {HTMLInputElement} */ (document.getElementById('tint-bri'));
const tintHueVal   = document.getElementById('tint-hue-val');
const tintSatVal   = document.getElementById('tint-sat-val');
const tintBriVal   = document.getElementById('tint-bri-val');
const btnResetTint = document.getElementById('btn-reset-tint');

// Effects panel
const effectsPanel = document.getElementById('effects-panel');
const btnFxClose   = document.getElementById('btn-fx-close');
const fxSearch     = /** @type {HTMLInputElement} */ (document.getElementById('fx-search'));
const fxList       = document.getElementById('fx-list');

// Editor panel
const editorPanel       = document.getElementById('editor-panel');
const editorSceneSelect = /** @type {HTMLSelectElement} */ (document.getElementById('editor-scene-select'));
const btnNewScene       = document.getElementById('btn-new-scene');
const btnEditorClose    = document.getElementById('btn-editor-close');
const editorMount       = document.getElementById('editor-mount');
const btnCompile        = document.getElementById('btn-compile');
const btnSaveScene      = document.getElementById('btn-save-scene');
const editorErrorEl     = document.getElementById('editor-error');

// ── Core objects ──────────────────────────────────────────────────────────────

const viz = new Visualizer(canvas);

// Lookup map for pattern fns: sceneId → SCENES entry
const patternMap = new Map(SCENES.map(s => [s.id, s]));

// ── Demo ledmap generator ─────────────────────────────────────────────────────

const demoOverlay   = document.getElementById('demo-overlay');
const demoCountSlider = /** @type {HTMLInputElement} */ (document.getElementById('demo-count'));
const demoCountVal  = document.getElementById('demo-count-val');

/**
 * Generate a synthetic ledmap for testing without real hardware.
 * Returns a ledmap object { n, map: [[x,y],...] } with normalised 0–1 coords.
 */
function generateDemoLedmap(shape, count) {
  const map = [];
  switch (shape) {
    case 'strip':
      for (let i = 0; i < count; i++)
        map.push([i / (count - 1), 0.5]);
      break;

    case 'grid': {
      const cols = Math.ceil(Math.sqrt(count));
      const rows = Math.ceil(count / cols);
      for (let i = 0; i < count; i++) {
        const r = Math.floor(i / cols), c = i % cols;
        map.push([cols > 1 ? c / (cols - 1) : 0.5, rows > 1 ? r / (rows - 1) : 0.5]);
      }
      break;
    }

    case 'circle':
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 - Math.PI / 2;
        map.push([0.5 + 0.45 * Math.cos(a), 0.5 + 0.45 * Math.sin(a)]);
      }
      break;

    case 'spiral':
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const a = t * Math.PI * 8 - Math.PI / 2;
        const r = t * 0.45;
        map.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
      }
      break;

    case 'rings': {
      // Concentric rings: inner 1, then 6, 12, 18, …
      const ringCounts = [];
      let placed = 0;
      ringCounts.push(1); placed = 1; // centre dot
      for (let ring = 1; placed < count; ring++) {
        const n = Math.min(ring * 6, count - placed);
        ringCounts.push(n);
        placed += n;
      }
      let idx = 0;
      ringCounts.forEach((n, ring) => {
        if (ring === 0) { map.push([0.5, 0.5]); idx++; return; }
        const r = (ring / (ringCounts.length - 1)) * 0.45;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          map.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
        }
        idx += n;
      });
      break;
    }
  }
  return { n: map.length, map };
}

function loadDemoShape(shape) {
  const count = parseInt(demoCountSlider.value);
  const ledmap = generateDemoLedmap(shape, count);
  viz.setLedmap(ledmap);
  demoOverlay.classList.add('hidden');
  if (state.scenes[0] && !state.activeScene) activateScene(state.scenes[0]);
  state.viewMode = 'local';

  // Highlight selected button
  document.querySelectorAll('.demo-shape-btn').forEach(b =>
    b.classList.toggle('selected', b.dataset.shape === shape));
}

// Wire demo shape buttons
document.querySelectorAll('.demo-shape-btn').forEach(btn => {
  btn.addEventListener('click', () => loadDemoShape(btn.dataset.shape));
});

// LED count slider
demoCountSlider.addEventListener('input', () => {
  demoCountVal.textContent = demoCountSlider.value;
});

// Drag-and-drop ledmap onto the demo overlay or anywhere on the page
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file?.name.endsWith('.json')) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(/** @type {string} */ (ev.target.result));
      if (!data.map || !Array.isArray(data.map)) throw new Error('Missing "map" array');
      viz.setLedmap(data);
      demoOverlay.classList.add('hidden');
      if (state.scenes[0] && !state.activeScene) activateScene(state.scenes[0]);
      state.viewMode = 'local';
    } catch (err) {
      alert(`Could not load ledmap: ${err.message}`);
    }
  };
  reader.readAsText(file);
});

// ── Feature 2 — Color tint ────────────────────────────────────────────────────

/**
 * Apply HSV tint to an RGB color.
 * If tint is not enabled, pass through unchanged.
 */
function applyTint(color, tint) {
  if (!tint.enabled) return color;
  const r = color.r / 255, g = color.g / 255, b = color.b / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const s = mx > 0 ? d / mx : 0;
  const v = mx;
  // Apply tint
  const nh = (h + tint.h / 360 + 1) % 1;
  const ns = Math.min(1, s * tint.s);
  const nv = Math.min(1, v * tint.v);
  // HSV → RGB
  const i = Math.floor(nh * 6), f = nh * 6 - i;
  const p = nv * (1 - ns), q = nv * (1 - f * ns), tt = nv * (1 - (1 - f) * ns);
  const cc = [[nv, tt, p], [q, nv, p], [p, nv, tt], [p, q, nv], [tt, p, nv], [nv, p, q]][i % 6];
  return { r: Math.round(cc[0] * 255), g: Math.round(cc[1] * 255), b: Math.round(cc[2] * 255) };
}

// Tint panel toggle
btnTint.addEventListener('click', () => {
  const open = tintPanel.classList.contains('hidden');
  tintPanel.classList.toggle('hidden', !open);
  btnTint.classList.toggle('active', open);
});

// Tint slider event handlers
tintHue.addEventListener('input', () => {
  state.tint.h = parseFloat(tintHue.value);
  tintHueVal.textContent = `${Math.round(state.tint.h)}°`;
  state.tint.enabled = true;
});

tintSat.addEventListener('input', () => {
  state.tint.s = parseFloat(tintSat.value) / 100;
  tintSatVal.textContent = `${Math.round(state.tint.s * 100)}%`;
  state.tint.enabled = true;
});

tintBri.addEventListener('input', () => {
  state.tint.v = parseFloat(tintBri.value) / 100;
  tintBriVal.textContent = `${Math.round(state.tint.v * 100)}%`;
  state.tint.enabled = true;
});

btnResetTint.addEventListener('click', () => {
  state.tint = { h: 0, s: 1.0, v: 1.0, enabled: false };
  tintHue.value = '0';
  tintSat.value = '100';
  tintBri.value = '100';
  tintHueVal.textContent = '0°';
  tintSatVal.textContent = '100%';
  tintBriVal.textContent = '100%';
});

// ── Feature 3 — Audio reactive ────────────────────────────────────────────────

async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.audio.context  = new AudioContext();
    const src = state.audio.context.createMediaStreamSource(stream);
    const analyser = state.audio.context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    src.connect(analyser);
    state.audio.analyser  = analyser;
    state.audio.dataArray = new Uint8Array(analyser.frequencyBinCount);
    state.audio.enabled   = true;
    btnAudio.classList.add('active');
    audioMeter.classList.remove('hidden');
  } catch (e) {
    console.warn('Mic access denied:', e);
  }
}

function stopAudio() {
  state.audio.context?.close();
  state.audio.enabled   = false;
  state.audio.context   = null;
  state.audio.analyser  = null;
  state.audio.dataArray = null;
  state.audio.bass = state.audio.mid = state.audio.treble = 0;
  btnAudio.classList.remove('active');
  audioMeter.classList.add('hidden');
}

function avgArr(arr, start, end) {
  let s = 0;
  for (let i = start; i < end; i++) s += arr[i];
  return s / Math.max(1, end - start);
}

function updateAudioLevels() {
  if (!state.audio.enabled || !state.audio.analyser) return;
  const { analyser, dataArray } = state.audio;
  analyser.getByteFrequencyData(dataArray);
  const len     = dataArray.length;
  const bassEnd = Math.floor(len * 0.20);
  const midEnd  = Math.floor(len * 0.60);
  state.audio.bass   = avgArr(dataArray, 0,       bassEnd) / 255;
  state.audio.mid    = avgArr(dataArray, bassEnd,  midEnd)  / 255;
  state.audio.treble = avgArr(dataArray, midEnd,   len)     / 255;
}

btnAudio.addEventListener('click', () => {
  if (state.audio.enabled) {
    stopAudio();
  } else {
    startAudio();
  }
});

// ── Feature 4 — Sequence / autoplay ──────────────────────────────────────────

function updateSequenceUI() {
  btnSeq.classList.toggle('active', state.sequence.active);
  btnSeq.textContent = state.sequence.active ? '⏸' : '▶';
  seqInterval.classList.toggle('hidden', !state.sequence.active);
}

function scheduleNext() {
  clearTimeout(state.sequence._timer);
  state.sequence._timer = setTimeout(() => {
    if (!state.sequence.active) return;
    state.sequence.idx = (state.sequence.idx + 1) % state.scenes.length;
    activateScene(state.scenes[state.sequence.idx], true /* internal */);
    scheduleNext();
  }, state.sequence.interval * 1000);
}

function startSequence() {
  state.sequence.active   = true;
  state.sequence.interval = parseInt(seqInterval.value) || 30;
  scheduleNext();
  updateSequenceUI();
}

function stopSequence() {
  state.sequence.active = false;
  clearTimeout(state.sequence._timer);
  updateSequenceUI();
}

btnSeq.addEventListener('click', () => {
  if (state.sequence.active) stopSequence();
  else startSequence();
});

seqInterval.addEventListener('change', () => {
  state.sequence.interval = parseInt(seqInterval.value) || 30;
  if (state.sequence.active) {
    clearTimeout(state.sequence._timer);
    scheduleNext();
  }
});

// ── Feature 1 — Parameter sliders ────────────────────────────────────────────

function buildParamSliders(scene) {
  paramsPanel.innerHTML = '';
  if (!scene?.params?.length) {
    paramsPanel.classList.add('hidden');
    return;
  }
  paramsPanel.classList.remove('hidden');

  scene.params.forEach(p => {
    const row = document.createElement('div');
    row.className = 'param-row';

    const label = document.createElement('span');
    label.className = 'param-label';
    label.textContent = p.label;

    const slider = /** @type {HTMLInputElement} */ (document.createElement('input'));
    slider.type      = 'range';
    slider.className = 'param-slider';
    slider.min       = String(p.min);
    slider.max       = String(p.max);
    slider.step      = '0.001';
    slider.value     = String(p.value);

    const valEl = document.createElement('span');
    valEl.className = 'param-val';
    valEl.textContent = p.value.toFixed(2);

    const resetBtn = document.createElement('button');
    resetBtn.className   = 'param-reset';
    resetBtn.textContent = '↺';
    resetBtn.title       = 'Reset to default';

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      valEl.textContent = v.toFixed(2);
      setParam(state.activeScene, p.id, v);
    });

    resetBtn.addEventListener('click', () => {
      slider.value = String(p.default);
      valEl.textContent = p.default.toFixed(2);
      setParam(state.activeScene, p.id, p.default);
    });

    row.append(label, slider, valEl, resetBtn);
    paramsPanel.appendChild(row);
  });
}

// ── Scene buttons ─────────────────────────────────────────────────────────────

function buildSceneButtons() {
  scenesRow.innerHTML = '';
  state.scenes.forEach(scene => {
    const btn = document.createElement('button');
    btn.className   = 'scene-btn';
    btn.dataset.id  = scene.id;
    btn.textContent = scene.name;
    btn.addEventListener('click', () => activateScene(scene));
    scenesRow.appendChild(btn);
  });
}

// ── Scene activation ──────────────────────────────────────────────────────────

/**
 * @param {object} scene
 * @param {boolean} [internal] — true when called by sequence timer (skip timer reset)
 */
function activateScene(scene, internal = false) {
  if (scene === state.activeScene) return;

  viz.startTransition();
  state.activeScene = scene;

  document.querySelectorAll('.scene-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.id === scene.id));

  // Build param sliders for the new scene
  buildParamSliders(scene);

  // Update editor dropdown if open
  if (!editorPanel.classList.contains('hidden')) {
    populateEditorDropdown();
  }

  if (state.wled?.connected && scene.preset != null) {
    state.wled.loadPreset(scene.preset).catch(() => {});
  }

  // If sequence is running and user manually picked a scene, reset the timer
  if (state.sequence.active && !internal) {
    state.sequence.idx = state.scenes.indexOf(scene);
    scheduleNext();
  }
}

// ── Device discovery ─────────────────────────────────────────────────────────

const devicePicker   = document.getElementById('device-picker');
const deviceList     = document.getElementById('device-list');
const deviceScanMsg  = document.getElementById('device-scanning-msg');
const btnPickerScan  = document.getElementById('btn-picker-scan');
const btnPickerClose = document.getElementById('btn-picker-close');
const btnFullScan    = document.getElementById('btn-picker-full-scan');

/**
 * Run /api/discover (fast) or /api/scan (full subnet).
 * Returns array of { name, ip, port, ver?, leds? }
 */
async function discoverDevices(full = false) {
  const endpoint = full ? '/api/scan' : '/api/discover';
  try {
    const r = await fetch(endpoint, { signal: AbortSignal.timeout(full ? 8000 : 3000) });
    return r.ok ? await r.json() : [];
  } catch { return []; }
}

/** Populate the device picker list from a results array. */
function renderDeviceList(devices) {
  if (!devices.length) {
    deviceList.innerHTML = `<p class="device-none">No WLED devices found on this network.</p>`;
    return;
  }
  deviceList.innerHTML = devices.map(d => `
    <div class="device-item" data-ip="${d.ip}">
      <span class="device-dot"></span>
      <div class="device-info">
        <div class="device-name">${d.name}</div>
        <div class="device-ip">${d.ip}</div>
      </div>
      <div class="device-meta">${d.leds != null ? d.leds + ' LEDs' : ''}${d.ver ? '<br>v' + d.ver : ''}</div>
    </div>
  `).join('');

  deviceList.querySelectorAll('.device-item').forEach(el => {
    el.addEventListener('click', () => {
      const ip = el.dataset.ip;
      devicePicker.classList.add('hidden');
      // Save to state so reconnect uses it
      if (state.config) state.config.wledIp = ip;
      connectWLED(ip);
    });
  });
}

/** Open the device picker and run a fast discover. */
async function openDevicePicker() {
  devicePicker.classList.remove('hidden');
  deviceList.innerHTML = `<p class="device-scanning" id="device-scanning-msg">Scanning…</p>`;
  btnPickerScan.disabled = true;
  btnPickerScan.textContent = 'Scanning…';

  const devices = await discoverDevices(false);
  renderDeviceList(devices);

  btnPickerScan.disabled = false;
  btnPickerScan.textContent = 'Scan again';
}

btnPickerScan.addEventListener('click',  () => openDevicePicker());
btnPickerClose.addEventListener('click', () => devicePicker.classList.add('hidden'));
btnFullScan.addEventListener('click', async () => {
  deviceList.innerHTML = `<p class="device-scanning">Full scan in progress…</p>`;
  btnFullScan.disabled = true;
  const devices = await discoverDevices(true);
  renderDeviceList(devices);
  btnFullScan.disabled = false;
});

// Make the conn-dot clickable to open the picker
connDot.style.cursor = 'pointer';
connDot.title = 'Click to scan for WLED devices';
connDot.addEventListener('click', openDevicePicker);

/**
 * Auto-discover WLED on startup.
 * If a config IP is set, try it and run discovery in parallel.
 * If the config IP doesn't respond within 4s, fall back to discovered device.
 */
async function autoDiscoverAndConnect(configIp) {
  // Start discovery in the background
  const discoveryPromise = discoverDevices(false);

  if (configIp) {
    // Try the configured IP immediately
    connectWLED(configIp);

    // Give it 4 seconds to connect; if not, check discovery results
    await new Promise(resolve => setTimeout(resolve, 4000));

    if (state.wled?.connected) return; // already connected — done
  }

  // Config IP failed or wasn't set — use discovery results
  const devices = await discoveryPromise;

  if (!devices.length) {
    // Nothing found — show picker on next conn-dot click, sit idle
    connDot.className = 'conn-dot';
    connDot.title = 'No WLED found — click to scan';
    return;
  }

  if (devices.length === 1) {
    // Exactly one device — connect automatically
    console.log(`[discover] Auto-connecting to ${devices[0].name} @ ${devices[0].ip}`);
    if (state.config) state.config.wledIp = devices[0].ip;
    connectWLED(devices[0].ip);
    return;
  }

  // Multiple devices — show picker
  renderDeviceList(devices);
  devicePicker.classList.remove('hidden');
}

// ── WLED connection ───────────────────────────────────────────────────────────

function connectWLED(ip) {
  if (state.wled) state.wled.disconnect();

  const client = new WLEDClient(ip);
  state.wled = client;

  connDot.className = 'conn-dot connecting';

  client.onConnect = () => {
    connDot.className = 'conn-dot connected';
    // Stay in 'local' until the first live frame arrives — avoids a black
    // flash if WLED is connected but not yet streaming colours.
    client.setBrightness(state.wledBri).catch(() => {});
    if (state.activeScene?.preset != null) {
      client.loadPreset(state.activeScene.preset).catch(() => {});
    }
    fetchWLEDEffects();
  };

  client.onDisconnect = () => {
    connDot.className = 'conn-dot error';
    state.viewMode = 'local'; // fall back to local pattern preview
  };

  client.onLiveFrame = (data, count) => {
    // Switch to live mode on the first frame received from WLED
    if (state.viewMode !== 'live') state.viewMode = 'live';
    viz.setLiveColors(data, count);
  };

  client.onStateUpdate = (obj) => {
    if (obj.bri != null) {
      state.wledBri = obj.bri;
      briSlider.value = String(obj.bri);
      briValEl.textContent = String(obj.bri);
    }
  };

  client.connect();
}

// ── Feature 5 — WLED effects browser ─────────────────────────────────────────

async function fetchWLEDEffects() {
  if (!state.config?.wledIp) return;
  try {
    const r = await fetch(`http://${state.config.wledIp}/json/effects`, {
      signal: AbortSignal.timeout(3000),
    });
    state.wledEffects = await r.json();
    buildEffectList();
  } catch { /* WLED not reachable */ }
}

function buildEffectList(filter = '') {
  fxList.innerHTML = '';
  const q = filter.toLowerCase();
  state.wledEffects.forEach((name, id) => {
    if (q && !name.toLowerCase().includes(q)) return;
    const btn = document.createElement('button');
    btn.className    = 'fx-btn';
    btn.dataset.id   = String(id);
    btn.textContent  = name;
    btn.classList.toggle('active', id === state.activeEffectId);
    btn.addEventListener('click', () => applyWLEDEffect(id));
    fxList.appendChild(btn);
  });
}

function applyWLEDEffect(id) {
  state.activeEffectId = id;
  // Only flip to live if WLED is actually connected — otherwise keep local preview
  if (state.wled?.connected) state.viewMode = 'live';
  document.querySelectorAll('.fx-btn').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.id) === id));
  state.wled?.setState({ seg: [{ fx: id }] }).catch(() => {});
}

// Effects panel open/close
function openEffectsPanel() {
  effectsPanel.classList.remove('hidden');
  // Force reflow to trigger transition
  effectsPanel.offsetHeight; // eslint-disable-line no-unused-expressions
  effectsPanel.classList.add('visible');
  btnFx.classList.add('active');
}

function closeEffectsPanel() {
  effectsPanel.classList.remove('visible');
  setTimeout(() => effectsPanel.classList.add('hidden'), 350);
  btnFx.classList.remove('active');
}

btnFx.addEventListener('click', () => {
  if (!effectsPanel.classList.contains('hidden')) {
    closeEffectsPanel();
  } else {
    openEffectsPanel();
  }
});

btnFxClose.addEventListener('click', closeEffectsPanel);

fxSearch.addEventListener('input', () => buildEffectList(fxSearch.value));

// ── Feature 6 — Operator code editor ─────────────────────────────────────────

let editorView = null;

function createEditorView(code) {
  if (editorView) {
    editorView.destroy();
    editorView = null;
  }
  editorView = new EditorView({
    doc: code,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
    parent: editorMount,
  });
}

function populateEditorDropdown() {
  editorSceneSelect.innerHTML = '';
  state.scenes.forEach(scene => {
    const opt = document.createElement('option');
    opt.value       = scene.id;
    opt.textContent = scene.name;
    opt.selected    = scene === state.activeScene;
    editorSceneSelect.appendChild(opt);
  });
}

function openEditor() {
  populateEditorDropdown();
  const scene = state.activeScene ?? state.scenes[0];
  if (scene) createEditorView(scene.code ?? '');
  editorErrorEl.textContent = '';
  editorPanel.classList.remove('hidden');
  editorPanel.offsetHeight; // eslint-disable-line no-unused-expressions
  editorPanel.classList.add('visible');
  btnEditor.classList.add('active');
}

function closeEditor() {
  editorPanel.classList.remove('visible');
  setTimeout(() => editorPanel.classList.add('hidden'), 350);
  btnEditor.classList.remove('active');
}

editorSceneSelect.addEventListener('change', () => {
  const scene = state.scenes.find(s => s.id === editorSceneSelect.value);
  if (scene) {
    editorErrorEl.textContent = '';
    createEditorView(scene.code ?? '');
  }
});

btnNewScene.addEventListener('click', () => {
  const defaultCode = `// Custom scene
// Variables: index, x, y, t, time, pixelCount
return hsv(fract(x + time * 0.5), 1, 0.8);`;
  createEditorView(defaultCode);
  editorErrorEl.textContent = '';
  // Temporarily deselect all options to indicate new scene editing
  for (const opt of editorSceneSelect.options) opt.selected = false;
});

btnCompile.addEventListener('click', () => {
  const code = editorView?.state.doc.toString() ?? '';
  const sceneId = editorSceneSelect.value;
  const scene = state.scenes.find(s => s.id === sceneId);

  if (scene?.source === 'pixelblaze') {
    editorErrorEl.textContent = 'Pixelblaze patterns are read-only in the editor.';
    return;
  }

  const { fn, error } = compile(code);
  if (error) {
    editorErrorEl.textContent = `Error: ${error}`;
    return;
  }
  editorErrorEl.textContent = '';
  if (scene) {
    scene.fn     = fn;
    scene.source = 'simple';
    scene.code   = code;
    // Switch to local to see the updated pattern
    state.viewMode = 'local';
    state.activeScene = scene;
  }
});

btnSaveScene.addEventListener('click', () => {
  const code = editorView?.state.doc.toString() ?? '';

  const { fn, error } = compile(code);
  if (error) {
    editorErrorEl.textContent = `Error: ${error}`;
    return;
  }
  editorErrorEl.textContent = '';

  // Generate unique name
  let idx = 1;
  while (state.scenes.find(s => s.name === `Custom ${idx}`)) idx++;
  const name = `Custom ${idx}`;
  const id   = `custom-${idx}`;

  const newScene = {
    id,
    name,
    preset: null,
    color:  '#888888',
    source: 'simple',
    fn,
    _mod:   null,
    params: [],
    code,
  };

  state.scenes.push(newScene);
  buildSceneButtons();
  activateScene(newScene);
  populateEditorDropdown();
  editorSceneSelect.value = id;
  state.viewMode = 'local';
});

btnEditor.addEventListener('click', openEditor);
btnEditorClose.addEventListener('click', closeEditor);

// ── Long-press on artist header to open editor ────────────────────────────────

let _holdTimer = null;

headerEl.addEventListener('pointerdown', (e) => {
  // Only trigger if not just a normal tap for fade-reveal
  _holdTimer = setTimeout(() => {
    _holdTimer = null;
    headerEl.classList.remove('editor-hold');
    openEditor();
  }, 1500);
  headerEl.classList.add('editor-hold');
});

function cancelHold() {
  if (_holdTimer != null) {
    clearTimeout(_holdTimer);
    _holdTimer = null;
  }
  headerEl.classList.remove('editor-hold');
}

headerEl.addEventListener('pointerup',     cancelHold);
headerEl.addEventListener('pointercancel', cancelHold);
headerEl.addEventListener('pointermove',   (e) => {
  // Cancel if pointer moves significantly
  if (Math.abs(e.movementX) > 6 || Math.abs(e.movementY) > 6) cancelHold();
});

// ── Animation loop ────────────────────────────────────────────────────────────

function tick(ts) {
  if (!state.animating) return;

  if (state.lastTs == null) state.lastTs = ts;
  const dt    = Math.min((ts - state.lastTs) / 1000, 0.1);
  state.lastTs = ts;
  state.t    += dt;
  state.time  = (state.t % 65.536) / 65.536;

  // Feature 3: update audio levels
  updateAudioLevels();

  // Update audio meter bars
  if (state.audio.enabled) {
    meterBass.style.setProperty('--h', state.audio.bass.toFixed(3));
    meterMid.style.setProperty('--h', state.audio.mid.toFixed(3));
    meterTreble.style.setProperty('--h', state.audio.treble.toFixed(3));
  }

  // Build audioState object for engine
  const audioState = state.audio.enabled
    ? { bass: state.audio.bass, mid: state.audio.mid, treble: state.audio.treble }
    : null;

  if (state.viewMode === 'local' && state.activeScene) {
    const scene      = state.activeScene;
    const { t, time } = state;
    const N          = viz.leds.length;

    // Run beforeRender phase (Pixelblaze patterns)
    runBeforeRender(scene, dt * 1000, audioState);

    // Evaluate per-pixel colors using unified evalScene, apply tint
    viz.computeColors((i, nx, ny) =>
      applyTint(evalScene(scene, i, nx, ny, t, time, N, audioState), state.tint)
    );
  }

  viz.render();
  requestAnimationFrame(tick);
}

// ── Brightness slider ─────────────────────────────────────────────────────────

briSlider.addEventListener('input', () => {
  const v = parseInt(briSlider.value);
  briValEl.textContent = String(v);
  state.wledBri = v;
  state.wled?.setBrightness(v).catch(() => {});
});

// ── Header reveal on tap ──────────────────────────────────────────────────────

headerEl.addEventListener('click', () => {
  // Don't fade-reveal if we just completed a long-press
  if (_holdTimer === null && !editorPanel.classList.contains('visible')) {
    headerEl.classList.remove('faded');
    clearTimeout(state._headerTimer);
    state._headerTimer = setTimeout(() => headerEl.classList.add('faded'), 5000);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  // Start animation immediately (shows idle background while loading)
  requestAnimationFrame(tick);

  try {
    // 1. Fetch config
    const config = await fetch('/api/config').then(r => r.json());
    state.config = config;

    // Apply branding
    document.title = config.pieceName
      ? `${config.pieceName} — ${config.artistName}`
      : (config.artistName ?? 'LED Installation');
    if (config.artistName) artistName.textContent = config.artistName;
    if (config.pieceName)  pieceNameEl.textContent = config.pieceName;
    if (config.accent) {
      document.documentElement.style.setProperty('--accent', config.accent);
    }

    // Build scene list: merge config.scenes (id + name + preset) with pattern fns
    const configScenes = config.scenes ?? SCENES.map(s => ({ id: s.id, name: s.name, preset: s.preset }));
    state.scenes = configScenes
      .map(cs => {
        const src = patternMap.get(cs.id);
        if (!src) return null;
        return { ...src, ...cs };
      })
      .filter(Boolean);

    // 2. Build buttons
    buildSceneButtons();

    // 3. Load ledmap
    try {
      const ledmap = await fetch('/api/ledmap').then(r => r.json());
      if (ledmap?.map?.length) {
        viz.setLedmap(ledmap);
        demoOverlay.classList.add('hidden'); // real ledmap loaded — no need for demo picker
        if (state.scenes[0]) activateScene(state.scenes[0]);
      }
      // If no real ledmap, demo overlay stays visible so user can pick a shape
    } catch { /* ledmap not configured yet — demo overlay stays */ }

    // 4. Connect to WLED — auto-discover if config IP is missing or unresponsive
    autoDiscoverAndConnect(config.wledIp ?? null);

    // 5. Auto-fade header after 8s so the canvas is unobstructed
    state._headerTimer = setTimeout(() => headerEl.classList.add('faded'), 8000);

  } catch (e) {
    console.error('Init error:', e);
    // Still shows idle background + default scene buttons from SCENES
    state.scenes = SCENES.slice();
    buildSceneButtons();
  }
}

init();
