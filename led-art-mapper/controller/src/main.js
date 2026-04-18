/**
 * main.js — controller state, event wiring, animation loop
 *
 * Boot sequence:
 *   1. Restore saved IP + ledmap from localStorage
 *   2. If ledmap saved: load it and hide drop overlay
 *   3. Build scene cards in control bar
 *   4. Start animation loop
 *   5. Auto-connect to WLED if IP saved
 *
 * Keyboard shortcuts (when not in an input):
 *   1–8      activate scene by position
 *   L        load ledmap.json
 *   Escape   dismiss any overlay
 */

import { Visualizer }          from './visualizer.js';
import { WLEDClient }          from './wled.js';
import { SCENES, evalPixel }   from './patterns.js';

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  scenes:       SCENES,
  activeScene:  null,  // scene object currently active

  viewMode:     'local', // 'local' | 'live'

  // Animation timing
  animating:    true,
  rafId:        null,
  t:            0,
  time:         0,
  lastTs:       null,

  // Cross-fade transition
  transitioning: false,

  // WLED
  wled:         null,   // WLEDClient instance
  wledBri:      200,
  wledSpd:      128,
  wledInt:      128,

  // UI idle timer
  idleTimer:    null,
  uiVisible:    true,
};

// ── DOM refs ──────────────────────────────────────────────────────────────

const canvas      = /** @type {HTMLCanvasElement}  */ (document.getElementById('main-canvas'));
const topBar      = document.getElementById('top-bar');
const controlBar  = document.getElementById('control-bar');
const dropOverlay = document.getElementById('drop-overlay');
const scenesRow   = document.getElementById('scenes-row');
const connDot     = document.getElementById('conn-dot');
const ipInput     = /** @type {HTMLInputElement}   */ (document.getElementById('wled-ip'));

// ── Core objects ──────────────────────────────────────────────────────────

const viz = new Visualizer(canvas);

// Pre-compile a Map of sceneId → fn for the preview renderer
const sceneFns = new Map(state.scenes.map(s => [s.id, s.fn]));

// ── Scene cards ───────────────────────────────────────────────────────────

function buildSceneCards() {
  scenesRow.innerHTML = '';

  state.scenes.forEach((scene, idx) => {
    const card = document.createElement('div');
    card.className   = 'scene-card';
    card.dataset.id  = scene.id;
    card.title       = `${scene.name} — preset #${scene.preset ?? '—'}`;

    const wrap = document.createElement('div');
    wrap.className = 'scene-canvas-wrap';

    const cvs = document.createElement('canvas');
    cvs.className  = 'scene-preview';
    cvs.width  = 192; // 2x for sharpness
    cvs.height = 116;
    cvs.style.width  = '96px';
    cvs.style.height = '58px';

    const foot = document.createElement('div');
    foot.className = 'scene-footer';
    foot.innerHTML = `
      <span class="scene-name">${scene.name}</span>
      <span class="scene-preset">${scene.preset != null ? '#' + scene.preset : ''}</span>`;

    const key = document.createElement('div');
    key.className   = 'scene-key';
    key.textContent = idx < 9 ? String(idx + 1) : '';

    wrap.appendChild(cvs);
    card.appendChild(wrap);
    card.appendChild(foot);
    card.appendChild(key);
    scenesRow.appendChild(card);

    // Register preview canvas with visualizer (staggered time offset)
    viz.registerPreview(scene.id, cvs, idx * 4.1);

    card.addEventListener('click', () => activateScene(scene));
  });
}

// ── Scene activation ──────────────────────────────────────────────────────

function activateScene(scene) {
  if (scene === state.activeScene) return;

  // Start cross-fade
  viz.startTransition();
  state.activeScene = scene;

  // Update card highlight
  document.querySelectorAll('.scene-card').forEach(c =>
    c.classList.toggle('active', c.dataset.id === scene.id));

  // Tell WLED to load the preset
  if (state.wled?.connected && scene.preset != null) {
    state.wled.loadPreset(scene.preset).catch(() => {});
  }
}

// ── Ledmap loading ────────────────────────────────────────────────────────

function loadLedmap(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(/** @type {string} */ (e.target.result));
      if (!data.map || !Array.isArray(data.map)) throw new Error('Missing "map" array');
      viz.setLedmap(data);
      dropOverlay.classList.add('hidden');
      // Persist for next session
      try { localStorage.setItem('led-ctrl-ledmap', JSON.stringify(data)); } catch {}
      // Auto-activate first scene if none active
      if (!state.activeScene) activateScene(state.scenes[0]);
    } catch (err) {
      alert(`Could not load ledmap: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function loadLedmapFromJSON(data) {
  viz.setLedmap(data);
  dropOverlay.classList.add('hidden');
  if (!state.activeScene) activateScene(state.scenes[0]);
}

// ── WLED connection ───────────────────────────────────────────────────────

function connectWLED(ip) {
  if (state.wled) state.wled.disconnect();

  const client = new WLEDClient(ip);
  state.wled = client;

  connDot.className = 'conn-dot connecting';

  client.onConnect = () => {
    connDot.className = 'conn-dot connected';
    try { localStorage.setItem('led-ctrl-ip', ip); } catch {}
    // Sync current brightness to hardware
    client.setBrightness(state.wledBri).catch(() => {});
  };

  client.onDisconnect = () => {
    connDot.className = 'conn-dot error';
  };

  client.onLiveFrame = (data, count) => {
    if (state.viewMode === 'live') {
      viz.setLiveColors(data, count);
    }
  };

  client.onStateUpdate = (obj) => {
    // Mirror brightness changes from hardware
    if (obj.bri != null) {
      state.wledBri = obj.bri;
      /** @type {HTMLInputElement} */ (document.getElementById('sl-bri')).value = obj.bri;
      document.getElementById('val-bri').textContent = obj.bri;
    }
  };

  client.connect();
}

// ── UI idle / auto-hide ───────────────────────────────────────────────────

function showUI() {
  if (!state.uiVisible) {
    state.uiVisible = true;
    topBar.classList.remove('hidden');
    controlBar.classList.remove('hidden');
    // Restore cursor on interactive elements — body still cursor:none
  }
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(hideUI, 4000);
}

function hideUI() {
  state.uiVisible = false;
  topBar.classList.add('hidden');
  controlBar.classList.add('hidden');
}

// ── Animation loop ────────────────────────────────────────────────────────

function tick(ts) {
  if (!state.animating) return;

  if (state.lastTs == null) state.lastTs = ts;
  const dt = Math.min((ts - state.lastTs) / 1000, 0.1);
  state.lastTs = ts;
  state.t    += dt;
  state.time  = (state.t % 65.536) / 65.536;

  // Compute main canvas colors
  if (state.viewMode === 'local' && state.activeScene?.fn) {
    const fn         = state.activeScene.fn;
    const t          = state.t;
    const time       = state.time;
    const N          = viz.leds.length;
    viz.computeColors((i, nx, ny) => evalPixel(fn, i, nx, ny, t, time, N));
  }
  // (Live mode: colors are written by onLiveFrame callback)

  // Render main canvas
  viz.render();

  // Render mini-preview cards
  if (viz.hasLedmap) {
    viz.renderPreviews(sceneFns, state.t, state.time, viz.leds.length);
  }

  state.rafId = requestAnimationFrame(tick);
}

// ── Event wiring ──────────────────────────────────────────────────────────

// Mouse/touch move → show UI
document.addEventListener('mousemove', showUI);
document.addEventListener('touchstart', showUI, { passive: true });

// Drag-and-drop ledmap onto canvas
document.addEventListener('dragover', e => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});
document.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) document.body.classList.remove('drag-over');
});
document.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file?.name.endsWith('.json')) loadLedmap(file);
});

// File pickers
function _wireFilePicker(triggerId, inputId) {
  document.getElementById(triggerId)?.addEventListener('click', () =>
    document.getElementById(inputId)?.click());
  document.getElementById(inputId)?.addEventListener('change', e => {
    const file = /** @type {HTMLInputElement} */ (e.target).files[0];
    if (file) loadLedmap(file);
    /** @type {HTMLInputElement} */ (e.target).value = '';
  });
}
_wireFilePicker('btn-browse',    'ledmap-input');
_wireFilePicker('btn-load-map',  'ledmap-input-bar');

// WLED connect button
document.getElementById('btn-connect').addEventListener('click', () => {
  const ip = ipInput.value.trim();
  if (ip) connectWLED(ip);
});

ipInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const ip = ipInput.value.trim();
    if (ip) connectWLED(ip);
  }
});

// ── WLED auto-scan ────────────────────────────────────────────────────────────
// Browser-side: probes well-known WLED addresses directly (WLED allows CORS).
// No server required — works in the standalone controller build.

const btnScan     = document.getElementById('btn-scan');
const scanResults = document.getElementById('scan-results');

// Close scan dropdown when clicking elsewhere
document.addEventListener('click', e => {
  if (!scanResults.contains(e.target) && e.target !== btnScan) {
    scanResults.classList.add('hidden');
  }
});

async function probeWLEDHost(host) {
  try {
    const r = await fetch(`http://${host}/json/info`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return null;
    const info = await r.json();
    return info?.ver ? { host, name: info.name ?? 'WLED', leds: info.leds?.count } : null;
  } catch { return null; }
}

async function scanForWLED() {
  btnScan.textContent   = '…';
  btnScan.disabled      = true;
  scanResults.innerHTML = '<div class="scan-msg">Scanning…</div>';
  scanResults.classList.remove('hidden');

  // Probe well-known WLED addresses in parallel from the browser
  const candidates = [
    'wled.local',    // WLED default mDNS name — works on most home networks
    '4.3.2.1',       // WLED AP mode (older firmware)
    '192.168.4.1',   // WLED AP mode (common)
  ];

  const probes  = await Promise.allSettled(candidates.map(probeWLEDHost));
  const devices = probes
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  btnScan.textContent = 'Scan';
  btnScan.disabled    = false;

  if (!devices.length) {
    scanResults.innerHTML = '<div class="scan-msg">No WLED device found. Check WiFi and try again.</div>';
    return;
  }

  // If exactly one device, connect immediately and close
  if (devices.length === 1) {
    const { host, name } = devices[0];
    ipInput.value = host;
    scanResults.classList.add('hidden');
    connectWLED(host);
    return;
  }

  // Multiple devices — show a pick list
  scanResults.innerHTML = devices.map(d => `
    <div class="scan-result-item" data-host="${d.host}">
      <span class="scan-result-dot"></span>
      <span class="scan-result-name">${d.name}${d.leds ? ` · ${d.leds} LEDs` : ''}</span>
      <span class="scan-result-ip">${d.host}</span>
    </div>
  `).join('');

  scanResults.querySelectorAll('.scan-result-item').forEach(el => {
    el.addEventListener('click', () => {
      const host = el.dataset.host;
      ipInput.value = host;
      scanResults.classList.add('hidden');
      connectWLED(host);
    });
  });
}

btnScan.addEventListener('click', e => {
  e.stopPropagation();
  scanForWLED();
});

// View mode toggle
document.getElementById('btn-local').addEventListener('click', () => {
  state.viewMode = 'local';
  document.getElementById('btn-local').classList.add('active');
  document.getElementById('btn-live').classList.remove('active');
  // Re-subscribe to live if connected (won't hurt)
});
document.getElementById('btn-live').addEventListener('click', () => {
  state.viewMode = 'live';
  document.getElementById('btn-live').classList.add('active');
  document.getElementById('btn-local').classList.remove('active');
});

// Sliders → WLED
function _wireSlider(sliderId, valId, handler) {
  const sl  = /** @type {HTMLInputElement} */ (document.getElementById(sliderId));
  const val = document.getElementById(valId);
  sl.addEventListener('input', () => {
    val.textContent = sl.value;
    handler(parseInt(sl.value));
  });
}

_wireSlider('sl-bri', 'val-bri', v => {
  state.wledBri = v;
  state.wled?.setBrightness(v).catch(() => {});
});

_wireSlider('sl-spd', 'val-spd', v => {
  state.wledSpd = v;
  state.wled?.setSpeedIntensity(v, state.wledInt).catch(() => {});
});

_wireSlider('sl-int', 'val-int', v => {
  state.wledInt = v;
  state.wled?.setSpeedIntensity(state.wledSpd, v).catch(() => {});
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  const tag = /** @type {HTMLElement} */ (e.target).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  // 1–8: activate scene by index
  const n = parseInt(e.key);
  if (n >= 1 && n <= 8 && state.scenes[n - 1]) {
    activateScene(state.scenes[n - 1]);
    return;
  }

  switch (e.key.toUpperCase()) {
    case 'L':
      document.getElementById('ledmap-input-bar')?.click();
      break;
    case 'ESCAPE':
      dropOverlay.classList.add('hidden');
      break;
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────

// Build scene cards
buildSceneCards();

// Restore saved state
const savedIp = localStorage.getItem('led-ctrl-ip');
if (savedIp) ipInput.value = savedIp;

const savedMapRaw = localStorage.getItem('led-ctrl-ledmap');
if (savedMapRaw) {
  try {
    loadLedmapFromJSON(JSON.parse(savedMapRaw));
  } catch { /* corrupt cache — ignore, overlay stays visible */ }
}

// Auto-connect if IP saved, otherwise auto-scan
if (savedIp) {
  setTimeout(() => connectWLED(savedIp), 500);
} else {
  setTimeout(() => scanForWLED(), 800);
}

// Start animation
state.rafId = requestAnimationFrame(tick);

// Show UI initially, then start idle timer
showUI();
