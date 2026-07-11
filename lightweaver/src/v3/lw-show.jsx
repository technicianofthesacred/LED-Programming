/* Light Weaver v3 — Show (sound-reactive) screen */
/* The piece listens: nine hand-tuned mandala modes driven by live audio
   (microphone or a song file), previewed on canvas with the simulator's
   radial-halo look, and optionally streamed to the card's LEDs through
   the bridge frame protocol (v1). Compute lives in lib/mandalaEngine.js;
   transport in lib/cardFrameStream.js — this file is UI + wiring only. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  createMandalaEngine,
  frameToHex,
  MODE_LIBRARY,
  RINGS,
  TOTAL_PIXELS,
} from '../lib/mandalaEngine.js';
import { createShowAudioFeatures } from '../lib/showAudioFeatures.js';
import {
  createConnectedSpatialTemplate,
  createMandalaSpatialTemplate,
  hasUsableConnectedLayout,
} from '../lib/showSpatialTemplate.js';
import { createCardFrameStream, DEFAULT_FRAME_FPS } from '../lib/cardFrameStream.js';
import { cardBridgeFeatureGap, hasCardBridge, pingCardBridge } from '../lib/cardBridge.js';
import { canPushDirectlyToCard, readStoredCardHost } from '../lib/cardConnection.js';

const SLOW_MODES = MODE_LIBRARY.filter((m) => m.tier === 'slow');
const LIVELY_MODES = MODE_LIBRARY.filter((m) => m.tier === 'lively');

// ── canvas render (port of the simulator's fused halo render) ─────────────
function rgbaStr(r, g, b, a) {
  return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
}

// One pre-rendered white radial-glow sprite, tinted per pixel — replaces the
// old per-pixel ctx.createRadialGradient (up to 675 gradient allocations per
// frame). Same soft three-stop falloff and the same additive 'lighter'
// compositing; per-pixel halo brightness rides on globalAlpha at draw time
// (the 0.444 mid stop is the full-brightness 0.4/0.9 stop ratio).
const GLOW_SPRITE_R = 32;
let glowSprite = null;
let glowTintCtx = null;
function ensureGlowSprite() {
  if (glowTintCtx) return true;
  if (typeof document === 'undefined') return false;
  const size = GLOW_SPRITE_R * 2;
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = size;
  const sctx = sprite.getContext('2d');
  const g = sctx.createRadialGradient(GLOW_SPRITE_R, GLOW_SPRITE_R, 0, GLOW_SPRITE_R, GLOW_SPRITE_R, GLOW_SPRITE_R);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.444)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, size, size);
  glowSprite = sprite;
  const tint = document.createElement('canvas');
  tint.width = tint.height = size;
  glowTintCtx = tint.getContext('2d');
  return true;
}

// `colors` is the engine's shared colorFrame() buffer (Float32Array TOTAL*3),
// computed once per frame and reused by the LED-frame encode.
function renderSpatial(ctx, engine, geom, colors, samples, templateKind) {
  const { W, cx, cy, maxR } = geom;
  const master = engine.getMaster();
  const haveGlow = ensureGlowSprite();
  const glowSize = GLOW_SPRITE_R * 2;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#050403';
  if (templateKind === 'mandala') {
    ctx.beginPath(); ctx.arc(cx, cy, maxR * 1.08, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(150,120,80,.04)';
    ctx.lineWidth = Math.max(1, W * 0.002);
    for (let r = 0; r < RINGS.length; r++) {
      ctx.beginPath(); ctx.arc(cx, cy, RINGS[r].rf * maxR, 0, Math.PI * 2); ctx.stroke();
    }
  } else {
    ctx.fillRect(0, 0, geom.W, geom.H);
  }
  const dot = 0.013 * maxR;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < samples.length; i++) {
    const v = Math.min(1, engine.getIntensity(i) * master);
    const x = cx + samples[i].x * maxR;
    const y = cy + samples[i].y * maxR;
    const cr = colors[i * 3], cg = colors[i * 3 + 1], cb = colors[i * 3 + 2];
    if (v > 0.03 && haveGlow) {
      const gr = dot * (1.4 + v * 3.0);
      // tint the white sprite with this pixel's color, then draw it additively
      glowTintCtx.globalCompositeOperation = 'copy';
      glowTintCtx.fillStyle = rgbaStr(cr, cg, cb, 1);
      glowTintCtx.fillRect(0, 0, glowSize, glowSize);
      glowTintCtx.globalCompositeOperation = 'destination-in';
      glowTintCtx.drawImage(glowSprite, 0, 0);
      ctx.globalAlpha = Math.min(0.9, 0.22 + v * 0.7);
      ctx.drawImage(glowTintCtx.canvas, x - gr, y - gr, gr * 2, gr * 2);
      ctx.globalAlpha = 1;
    }
    const lit = Math.max(0.05, v);
    ctx.fillStyle = rgbaStr(cr, cg, cb, Math.min(1, 0.12 + lit * 0.85));
    ctx.beginPath(); ctx.arc(x, y, dot, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

// LED-frame encodes (frameRGB → resample → hex) are gated to the stream's
// ~18fps wire cadence instead of every RAF tick; the small epsilon keeps RAF's
// ~16.7ms quantization from landing the cadence a whole tick late.
const STREAM_ENCODE_GAP_MS = 1000 / DEFAULT_FRAME_FPS - 8;

// ── small UI pieces (v3 token styling, inline where no class fits) ─────────
const chipStyle = (on) => ({
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  border: `1px solid ${on ? 'var(--accent)' : 'var(--border-soft)'}`,
  background: on ? 'var(--accent)' : 'var(--bg-elev)',
  color: on ? 'var(--on-accent)' : 'var(--text-mid)',
});

function Chip({ on, onClick, children, title }) {
  return (
    <button type="button" title={title} style={chipStyle(on)} onClick={onClick}>{children}</button>
  );
}

function ChipRow({ children }) {
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{children}</div>;
}

function Slider({ k, v, value, min, max, step, onChange }) {
  return (
    <div className="slider-row">
      <div className="lab"><span className="k">{k}</span><span className="v">{v}</span></div>
      <input className="lw" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

function BandMeter({ label, value }) {
  return (
    <div style={{ flex: 1 }}>
      <div className="mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', textAlign: 'center', marginBottom: 3 }}>{label}</div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elev)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.round(Math.min(1, value) * 100)}%`, background: 'var(--accent)', transition: 'width 0.08s linear' }} />
      </div>
    </div>
  );
}

function ShowScreen({ go }) {
  const { strips, hidden } = useProject();
  const mandalaTemplate = useMemo(() => createMandalaSpatialTemplate(), []);
  const connectedUsable = useMemo(
    () => hasUsableConnectedLayout(strips, hidden),
    [strips, hidden],
  );
  const connectedTemplate = useMemo(
    () => createConnectedSpatialTemplate({ strips, hidden }),
    [strips, hidden],
  );
  const [requestedTemplate, setRequestedTemplate] = useState('connected');
  const activeTemplateKind = requestedTemplate === 'connected' && connectedUsable
    ? 'connected'
    : 'mandala';
  const activeTemplate = activeTemplateKind === 'connected' ? connectedTemplate : mandalaTemplate;
  const activePixels = activeTemplate.length || TOTAL_PIXELS;
  const outputOrder = useMemo(() => {
    const byStrip = new Map();
    return activeTemplate.map((sample) => {
      const pixelIndex = byStrip.get(sample.stripId) || 0;
      byStrip.set(sample.stripId, pixelIndex + 1);
      return `${sample.stripId}:${pixelIndex}`;
    }).join(',');
  }, [activeTemplate]);
  const samplePositions = useMemo(() => activeTemplate
    .map((sample) => `${sample.x.toFixed(3)}:${sample.y.toFixed(3)}`)
    .join(','), [activeTemplate]);

  // ── engine + mutable per-frame machinery live in refs ────────────────────
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createMandalaEngine();
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const templateRef = useRef(activeTemplate);
  const templateKindRef = useRef(activeTemplateKind);
  const audioRef = useRef({ ctx: null, analyser: null, source: null, micStream: null, elSource: null, objectUrl: '' });
  const featureRef = useRef(null);
  const playerRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null);
  const rgbBufRef = useRef(null);
  const colorBufRef = useRef(null);
  const hexBufRef = useRef(null);
  const renderFrameRef = useRef(null);
  const healthNoticeShownRef = useRef(false);
  const pausedRef = useRef(false);
  const resetTimingRef = useRef(false);
  const sourceRequestGenerationRef = useRef(0);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [modeKey, setModeKey] = useState('strata');
  const [preset, setPreset] = useState('Calm');
  const [sensitivity, setSensitivity] = useState(1.0);
  const [master, setMaster] = useState(0.75);
  const [source, setSource] = useState('quiet'); // quiet | mic | file
  const [fileName, setFileName] = useState('');
  const [songPaused, setSongPaused] = useState(false);
  const [onLights, setOnLights] = useState(false);
  const [lightsBusy, setLightsBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: 'err'|'info', text, action? }
  const [levels, setLevels] = useState({ bass: 0, mid: 0, high: 0, energy: 0 });

  const modeInfo = MODE_LIBRARY.find((m) => m.key === modeKey) || MODE_LIBRARY[0];

  useEffect(() => {
    templateRef.current = activeTemplate;
    templateKindRef.current = activeTemplateKind;
    engineRef.current.setTemplate(activeTemplate);
    rgbBufRef.current = null;
    colorBufRef.current = null;
    hexBufRef.current = null;
    if (pausedRef.current) renderFrameRef.current?.({ push: true });
  }, [activeTemplate, activeTemplateKind]);

  // ── the one animation loop: analyze → tick → paint → (stream) ───────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const geom = { W: 0, H: 0, cx: 0, cy: 0, maxR: 0 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = () => {
      const rect = canvas.getBoundingClientRect();
      geom.W = rect.width; geom.H = rect.height;
      canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      geom.cx = rect.width / 2; geom.cy = rect.height / 2;
      geom.maxR = Math.min(rect.width, rect.height) * 0.46;
    };
    size();
    let resizeTimer = 0;
    const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(size, 150); };
    window.addEventListener('resize', onResize);

    let raf = 0;
    let prev = performance.now();
    let meterAt = 0;
    let encodeAt = 0;
    let frameVersion = 0;
    const encodeFrame = () => {
      const stream = streamRef.current;
      if (!stream) return;
      rgbBufRef.current = engineRef.current.frameRGB(rgbBufRef.current, colorBufRef.current);
      hexBufRef.current = frameToHex(rgbBufRef.current, hexBufRef.current);
      stream.push(hexBufRef.current);
    };
    const renderFrame = ({ push = false } = {}) => {
      const engine = engineRef.current;
      colorBufRef.current = engine.colorFrame(colorBufRef.current);
      renderSpatial(
        ctx,
        engine,
        geom,
        colorBufRef.current,
        templateRef.current,
        templateKindRef.current,
      );
      frameVersion += 1;
      if (stageRef.current) stageRef.current.dataset.frameVersion = String(frameVersion);
      if (push) encodeFrame();
    };
    renderFrameRef.current = renderFrame;
    const step = (now) => {
      if (resetTimingRef.current) {
        prev = now;
        resetTimingRef.current = false;
      }
      if (pausedRef.current) {
        raf = requestAnimationFrame(step);
        return;
      }
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const engine = engineRef.current;
      const audio = audioRef.current;
      if (audio.analyser && featureRef.current && engine.isListening()) {
        featureRef.current.updateAnalyser(audio.analyser, dt);
        engine.setFeatures(featureRef.current.getFeatures());
      }
      engine.tick(dt);
      // Per-pixel colors are computed once and shared by canvas + wire encode.
      renderFrame();
      const stream = streamRef.current;
      if (stream && now - encodeAt >= STREAM_ENCODE_GAP_MS) {
        encodeAt = now;
        encodeFrame();
      }
      if (now - meterAt > 120) {
        meterAt = now;
        setLevels(engine.getLevels());
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      renderFrameRef.current = null;
      cancelAnimationFrame(raf);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // ── teardown on unmount: lights released, audio closed ───────────────────
  useEffect(() => () => {
    sourceRequestGenerationRef.current += 1;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) void stream.stop();
    const audio = audioRef.current;
    audio.micStream?.getTracks?.().forEach((track) => track.stop());
    audio.micStream = null;
    if (audio.objectUrl) URL.revokeObjectURL(audio.objectUrl);
    try { audio.ctx?.close(); } catch { /* already closed */ }
    audio.ctx = null;
    audio.analyser = null;
  }, []);

  // ── returning to a backgrounded tab: revive audio, explain any pause ─────
  // Browsers clamp timers in hidden tabs (Chrome's 5-minute intensive
  // throttling clamps them to once a minute), so the stream's keepalive can
  // gap past the card's 2s watchdog and the lights fall back to their own
  // pattern until we resume. RAF pausing is fine — the pump re-sends the
  // latest frame — but a long gap deserves a friendly word.
  useEffect(() => {
    const onVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      const audio = audioRef.current;
      if (!pausedRef.current && audio.ctx && (audio.ctx.state === 'suspended' || audio.ctx.state === 'interrupted')) {
        audio.ctx.resume().catch(() => { /* resumes on the next user gesture */ });
      }
      const stream = streamRef.current;
      if (stream) {
        const stats = stream.getStats();
        if (stats.lastSentAt && Date.now() - stats.lastSentAt > 2500) {
          setNotice({ kind: 'info', text: "The lights paused while this tab was in the background — they're back now." });
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ── audio plumbing (mirrors the simulator's Web Audio pipeline) ──────────
  const ensureAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audio.ctx = new Ctx();
      audio.analyser = audio.ctx.createAnalyser();
      audio.analyser.fftSize = 2048;
      // Feature extraction owns the musical envelope, so the browser analyser
      // only gets a light anti-jitter pass instead of a second heavy smoother.
      audio.analyser.smoothingTimeConstant = 0.15;
      featureRef.current = createShowAudioFeatures({
        sampleRate: audio.ctx.sampleRate,
        fftSize: audio.analyser.fftSize,
      });
    }
    // iOS reports 'interrupted' (phone call, Siri, control center) — treat it
    // exactly like 'suspended' and try to resume.
    if (audio.ctx.state === 'suspended' || audio.ctx.state === 'interrupted') {
      audio.ctx.resume().catch(() => { /* resumes on the next user gesture */ });
    }
    return audio;
  }, []);

  const connectSource = useCallback((node, toSpeakers) => {
    const audio = audioRef.current;
    if (audio.source) { try { audio.source.disconnect(); } catch { /* noop */ } }
    try { audio.analyser.disconnect(); } catch { /* noop */ }
    node.connect(audio.analyser);
    if (toSpeakers) audio.analyser.connect(audio.ctx.destination);
    audio.source = node;
  }, []);

  const stopMicTracks = useCallback(() => {
    const audio = audioRef.current;
    audio.micStream?.getTracks?.().forEach((track) => track.stop());
    audio.micStream = null;
  }, []);

  const goQuiet = useCallback(() => {
    sourceRequestGenerationRef.current += 1;
    stopMicTracks();
    try { playerRef.current?.pause(); } catch { /* noop */ }
    pausedRef.current = false;
    resetTimingRef.current = true;
    setSongPaused(false);
    engineRef.current.setListening(false);
    setSource('quiet');
  }, [stopMicTracks]);

  const startMic = useCallback(async () => {
    // iOS: the AudioContext must be created/resumed synchronously inside the
    // tap — any await first (like getUserMedia's permission prompt) consumes
    // the user-gesture activation and the context stays suspended forever.
    const requestGeneration = sourceRequestGenerationRef.current + 1;
    sourceRequestGenerationRef.current = requestGeneration;
    const audio = ensureAudio();
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (sourceRequestGenerationRef.current !== requestGeneration) {
        mic?.getTracks?.().forEach((track) => track.stop());
        return;
      }
      try { playerRef.current?.pause(); } catch { /* noop */ }
      pausedRef.current = false;
      resetTimingRef.current = true;
      setSongPaused(false);
      stopMicTracks();
      audio.micStream = mic;
      connectSource(audio.ctx.createMediaStreamSource(mic), false);
      engineRef.current.setListening(true);
      setSource('mic');
      setNotice(null);
    } catch (error) {
      if (sourceRequestGenerationRef.current !== requestGeneration) return;
      setNotice({ kind: 'err', text: `Couldn't use the microphone: ${error?.message || error}` });
    }
  }, [connectSource, ensureAudio, stopMicTracks]);

  const pickFile = useCallback(() => fileInputRef.current?.click(), []);

  const onFile = useCallback((e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const requestGeneration = sourceRequestGenerationRef.current + 1;
    sourceRequestGenerationRef.current = requestGeneration;
    const audio = ensureAudio();
    const player = playerRef.current;
    stopMicTracks();
    if (audio.objectUrl) URL.revokeObjectURL(audio.objectUrl);
    audio.objectUrl = URL.createObjectURL(file);
    player.src = audio.objectUrl;
    player.loop = true;
    // A media element can only be wrapped in a source node once — create it the
    // first time, re-route it back through the analyser on every later pick
    // (the mic disconnects it when it takes over).
    if (!audio.elSource) audio.elSource = audio.ctx.createMediaElementSource(player);
    connectSource(audio.elSource, true);
    let playResult;
    try {
      playResult = player.play();
    } catch (error) {
      playResult = Promise.reject(error);
    }
    pausedRef.current = false;
    resetTimingRef.current = true;
    setSongPaused(false);
    engineRef.current.setListening(true);
    setFileName(file.name);
    setSource('file');
    setNotice(null);
    Promise.resolve(playResult).catch((error) => {
      if (sourceRequestGenerationRef.current !== requestGeneration) return;
      pausedRef.current = true;
      setSongPaused(true);
      setNotice({ kind: 'err', text: `Couldn't play the song: ${error?.message || error}` });
    });
  }, [connectSource, ensureAudio, stopMicTracks]);

  const toggleSongPause = useCallback(() => {
    if (source !== 'file' || !fileName) return;
    const requestGeneration = sourceRequestGenerationRef.current;
    const audio = audioRef.current;
    const player = playerRef.current;
    if (pausedRef.current) {
      let resumeResult = Promise.resolve();
      try {
        if (audio.ctx) resumeResult = Promise.resolve(audio.ctx.resume());
      } catch (error) {
        resumeResult = Promise.reject(error);
      }
      let playResult;
      try {
        playResult = player?.play();
      } catch (error) {
        playResult = Promise.reject(error);
      }
      Promise.all([resumeResult, Promise.resolve(playResult)]).then(() => {
        if (sourceRequestGenerationRef.current === requestGeneration && source === 'file') {
          pausedRef.current = false;
          resetTimingRef.current = true;
          setSongPaused(false);
          setNotice(null);
        }
      }).catch((error) => {
        if (sourceRequestGenerationRef.current !== requestGeneration || source !== 'file') return;
        try { player?.pause(); } catch { /* noop */ }
        pausedRef.current = true;
        setSongPaused(true);
        setNotice({ kind: 'err', text: `Couldn't resume the song: ${error?.message || error}` });
      });
      return;
    }
    try { player?.pause(); } catch { /* noop */ }
    pausedRef.current = true;
    setSongPaused(true);
  }, [fileName, source]);

  // ── control handlers ─────────────────────────────────────────────────────
  const chooseMode = useCallback((key) => {
    engineRef.current.setMode(key);
    setModeKey(key);
  }, []);
  const choosePreset = useCallback((name) => {
    engineRef.current.setPreset(name);
    setPreset(name);
    setMaster(engineRef.current.getMaster());
  }, []);
  const changeSensitivity = useCallback((value) => {
    engineRef.current.setSensitivity(value);
    setSensitivity(value);
  }, []);
  const changeMaster = useCallback((value) => {
    engineRef.current.setMaster(value);
    setMaster(value);
  }, []);

  // ── the lights: start/stop the card frame stream ─────────────────────────
  const stopLights = useCallback(async (stopNotice) => {
    const stream = streamRef.current;
    if (!stream) return;
    streamRef.current = null;
    healthNoticeShownRef.current = false;
    setOnLights(false);
    if (stopNotice) setNotice(stopNotice);
    try { await stream.stop(); } catch { /* the card reverts on its own after 2s */ }
  }, []);

  // Delivery health from the streamer: warn when frames stop reaching the
  // lights, and auto-stop (button back to its off state) when the path is
  // clearly gone — the card page popup closed, or ~15s of sustained failure.
  const handleStreamHealth = useCallback((health) => {
    if (!streamRef.current) return;
    if (health.delivered) {
      if (healthNoticeShownRef.current) {
        healthNoticeShownRef.current = false;
        setNotice(null);
      }
      return;
    }
    const bridgeGone = health.reason === 'bridge-missing';
    if ((bridgeGone && health.failingForMs >= 1200 && health.consecutiveFailures >= 3) || health.failingForMs >= 15000) {
      void stopLights({
        kind: 'err',
        text: bridgeGone
          ? 'The card page closed, so the show stopped reaching the lights. Open the card page again, then press "Play on the lights".'
          : "The lights stopped receiving the show, so it's been paused. Check that your card is on and its page is open, then try again.",
      });
      return;
    }
    if (health.failingForMs >= 3000 && !healthNoticeShownRef.current) {
      healthNoticeShownRef.current = true;
      setNotice({ kind: 'err', text: "The lights aren't receiving the show — check that your card page is still open." });
    }
  }, [stopLights]);

  const toggleLights = useCallback(async () => {
    if (lightsBusy) return;
    if (streamRef.current) {
      setLightsBusy(true);
      await stopLights();
      setLightsBusy(false);
      return;
    }
    setLightsBusy(true);
    try {
      if (!canPushDirectlyToCard()) {
        if (!hasCardBridge()) {
          setNotice({
            kind: 'err',
            text: "Studio can't reach your lights from here yet. Open your piece's card page once (tap “Open Lightweaver Studio” on it) so it can carry the show.",
          });
          return;
        }
        // Elicit a versioned reply so a quietly-bootstrapped bridge reports
        // its real protocol version before we gate on it. Retry once — a
        // sleepy card page often misses the first ping.
        let pinged = false;
        try {
          await pingCardBridge({ timeoutMs: 2500 });
          pinged = true;
        } catch {
          try {
            await pingCardBridge({ timeoutMs: 2500 });
            pinged = true;
          } catch { /* the card never answered — handled below */ }
        }
        const gap = cardBridgeFeatureGap('frame');
        if (gap) {
          if (!pinged && gap.reported === 0) {
            // The card never replied, so we don't actually know its firmware
            // is old — don't send anyone to reflash over a connection hiccup.
            setNotice({ kind: 'err', text: "Couldn't check your card — make sure the card page is open, then try again." });
          } else {
            // The card really reported a version below what streaming needs.
            setNotice({ kind: 'err', text: gap.message, action: 'flash' });
          }
          return;
        }
      }
      healthNoticeShownRef.current = false;
      const stream = createCardFrameStream({ host: readStoredCardHost(), onHealth: handleStreamHealth });
      stream.start();
      streamRef.current = stream;
      setOnLights(true);
      setNotice(null);
    } finally {
      setLightsBusy(false);
    }
  }, [lightsBusy, stopLights, handleStreamHealth]);

  const listening = source !== 'quiet';

  return (
    <div className="screen">
      <div className="sh">
        {/* top bar */}
        <div className="transport">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-hi)' }}>The piece listens</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
              {listening ? `hearing ${source === 'mic' ? 'the room' : (fileName || 'your song')} · ${modeInfo.name.toLowerCase()}` : 'quiet — pick a sound source to begin'}
            </span>
          </div>
          <div className="tp-spring" />
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
            {onLights ? `playing on ${activePixels} LEDs` : `${activePixels} LEDs ready`}
          </span>
          <button
            type="button"
            className={'btn' + (onLights ? ' primary' : '')}
            onClick={toggleLights}
            disabled={lightsBusy}
          >
            {onLights ? 'Stop playing on the lights' : 'Play on the lights'}
          </button>
        </div>

        {/* body: stage + controls */}
        <div className="sh-body">
          <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24, background: 'var(--bg-canvas)', overflow: 'auto' }}>
            <div
              role="group"
              aria-label="Show layout template"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, flexWrap: 'wrap' }}
            >
              <button
                type="button"
                data-testid="show-template-mandala"
                aria-pressed={activeTemplateKind === 'mandala'}
                onClick={() => setRequestedTemplate('mandala')}
                title="Preview and stream the five-ring Mandala map"
                style={chipStyle(activeTemplateKind === 'mandala')}
              >
                Mandala
              </button>
              <button
                type="button"
                data-testid="show-template-connected"
                aria-pressed={activeTemplateKind === 'connected'}
                disabled={!connectedUsable}
                onClick={() => setRequestedTemplate('connected')}
                title={connectedUsable ? 'Preview and stream your connected layout' : 'No visible connected pixels'}
                style={{ ...chipStyle(activeTemplateKind === 'connected'), opacity: connectedUsable ? 1 : 0.45, cursor: connectedUsable ? 'pointer' : 'not-allowed' }}
              >
                Connected layout
              </button>
            </div>
            {!connectedUsable && (
              <div style={{ maxWidth: 460, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-faint)', textAlign: 'center' }}>
                Connected layout has no visible pixels, so Show is using the Mandala template.
              </div>
            )}
            <div
              ref={stageRef}
              data-testid="show-stage"
              data-template={activeTemplateKind}
              data-frame-size={activePixels}
              data-output-order={outputOrder}
              data-sample-positions={samplePositions}
              style={{
              position: 'relative',
              width: 'min(100%, 520px)',
              aspectRatio: '1 / 1',
              borderRadius: activeTemplateKind === 'mandala' ? '50%' : 'var(--r-lg)',
              background: 'radial-gradient(circle at 50% 44%, #160f09 0%, #0b0705 78%, #060403 100%)',
              boxShadow: '0 40px 90px rgba(0,0,0,.55), inset 0 0 0 2px rgba(120,90,55,.22), inset 0 0 60px rgba(0,0,0,.7)',
            }}>
              <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', borderRadius: activeTemplateKind === 'mandala' ? '50%' : 'var(--r-lg)' }} />
            </div>
            <div className="mono" style={{ fontSize: 10.5, letterSpacing: '0.06em', color: 'var(--text-lo)', textAlign: 'center' }}>
              {modeInfo.name} · {preset === 'Calm' ? 'calm' : 'listening closely'}
            </div>
            {notice && (
              <div style={{
                maxWidth: 460,
                padding: '10px 14px',
                borderRadius: 'var(--r-md)',
                border: `1px solid ${notice.kind === 'err' ? 'var(--danger)' : 'var(--border)'}`,
                background: 'var(--bg-panel)',
                color: 'var(--text-mid)',
                fontSize: 12.5,
                lineHeight: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}>
                <span style={{ flex: 1 }}>{notice.text}</span>
                {notice.action === 'flash' && (
                  <button type="button" className="btn primary" onClick={() => go?.('flash')}>Open Flash</button>
                )}
                <button type="button" className="btn" onClick={() => setNotice(null)}>Dismiss</button>
              </div>
            )}
          </div>

          {/* controls */}
          <aside className="sh-insp">
            <div className="sh-insp-body">
              <div className="sec-h"><span className="t">Sound</span><span className="line" /></div>
              <ChipRow>
                <Chip on={source === 'mic'} onClick={startMic} title="Listen through your device's microphone">Microphone</Chip>
                <Chip on={source === 'file'} onClick={pickFile} title="Play a song from a file">Song file</Chip>
                <Chip on={source === 'quiet'} onClick={goQuiet} title="Stop listening — the piece settles to a dim glow">Quiet</Chip>
              </ChipRow>
              {source === 'file' && fileName && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <button type="button" className="btn" data-testid="show-pause" onClick={toggleSongPause}>
                    {songPaused ? 'Resume song' : 'Pause song'}
                  </button>
                  <span className="mono" data-testid="show-transport-state" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    {songPaused ? 'paused' : 'playing'}
                  </span>
                  <span className="mono" style={{ minWidth: 0, fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <BandMeter label="deep" value={levels.bass} />
                <BandMeter label="middle" value={levels.mid} />
                <BandMeter label="sparkle" value={levels.high} />
              </div>
              <Slider k="Sensitivity" v={`${sensitivity.toFixed(1)}×`} value={sensitivity} min={0.3} max={3} step={0.05} onChange={changeSensitivity} />

              <div className="field-sep" />
              <div className="sec-h"><span className="t">Mode</span><span className="line" /></div>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '2px 0 6px' }}>Slow &amp; meditative</div>
              <ChipRow>
                {SLOW_MODES.map((m) => (
                  <Chip key={m.key} on={modeKey === m.key} onClick={() => chooseMode(m.key)} title={m.desc}>{m.name}</Chip>
                ))}
              </ChipRow>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '10px 0 6px' }}>Livelier</div>
              <ChipRow>
                {LIVELY_MODES.map((m) => (
                  <Chip key={m.key} on={modeKey === m.key} onClick={() => chooseMode(m.key)} title={m.desc}>{m.name}</Chip>
                ))}
              </ChipRow>
              <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-lo)', marginTop: 9, minHeight: '3.1em' }}>{modeInfo.desc}</div>

              <div className="field-sep" />
              <div className="sec-h"><span className="t">Feel</span><span className="line" /></div>
              <ChipRow>
                <Chip on={preset === 'Calm'} onClick={() => choosePreset('Calm')} title="The piece's true self — gentle, warm">Calm</Chip>
                <Chip on={preset === 'Active'} onClick={() => choosePreset('Active')} title="Listens more closely — deeper swells, never faster">Active</Chip>
              </ChipRow>
              <Slider k="Brightness" v={master.toFixed(2)} value={master} min={0.2} max={0.85} step={0.01} onChange={changeMaster} />
              <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-faint)', marginTop: 8 }}>
                Warm, never harsh. Nothing spins fast or snaps — mostly-dark is allowed, which makes the gold precious.
              </div>
            </div>
          </aside>
        </div>
      </div>

      {/* hidden audio plumbing */}
      <input ref={fileInputRef} data-testid="show-song-input" type="file" accept="audio/*" style={{ display: 'none' }} onChange={onFile} />
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={playerRef} style={{ display: 'none' }} />
    </div>
  );
}

export { ShowScreen };
