import { useState, useEffect, useRef, useMemo } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { PATTERNS, DEFAULT_PARAMS } from '../data.js';
import { PATTERNS as LIB_PATTERNS } from '../lib/patterns-library.js';
import { compile } from '../lib/patterns.js';
import {
  CUSTOM_PATTERNS_EVENT,
  deleteCustomPattern,
  loadCustomPatterns,
  saveCustomPattern,
} from '../lib/customPatterns.js';
import { getPatternById, getPatternCode } from '../lib/patternRegistry.js';
import { parseParamsFromCode } from '../lib/patternParams.js';
import { useProject } from '../state/ProjectContext.jsx';

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
  return {
    ...DEFAULT_PATTERN_JOURNEY,
    ...(params.__journey || {}),
    colorStops: [
      ...(params.__journey?.colorStops || DEFAULT_PATTERN_JOURNEY.colorStops),
      ...DEFAULT_PATTERN_JOURNEY.colorStops,
    ].slice(0, 3).map((hex, index) => normalizeHexColor(hex, DEFAULT_PATTERN_JOURNEY.colorStops[index])),
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

export function CardsMode({ patternId, onSelectPattern, params, onParamChange, palette, onPaletteChange }) {
  const { timelinePlayhead, showDuration, setShowClips } = useProject();
  const [search, setSearch]     = useState('');
  const [showFavs, setShowFavs] = useState(false);
  const [cat, setCat]           = useState('all');
  const [sortMode, setSortMode] = useState('default'); // 'default' | 'alpha' | 'random'
  const [favs, setFavsState]    = useState(loadFavs);
  const [presets, setPresetsState] = useState(loadPresets);
  const [customPatterns, setCustomPatterns] = useState(loadCustomPatterns);
  const [recentIds, setRecentIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_RECENT_KEY) || '[]'); } catch { return []; }
  });

  useEffect(() => {
    const handler = () => setCustomPatterns(loadCustomPatterns());
    window.addEventListener(CUSTOM_PATTERNS_EVENT, handler);
    return () => window.removeEventListener(CUSTOM_PATTERNS_EVENT, handler);
  }, []);

  const savePreset = () => {
    const name = prompt('Preset name:');
    if (!name?.trim()) return;
    const next = { ...presets, [`${patternId}/${name.trim()}`]: { ...params } };
    setPresetsState(next);
    savePresets(next);
  };

  const loadPreset = (key) => {
    const p = presets[key];
    if (!p) return;
    Object.entries(p).forEach(([k, v]) => onParamChange(k, v));
  };

  const deletePreset = (key, e) => {
    e.stopPropagation();
    const next = { ...presets };
    delete next[key];
    setPresetsState(next);
    savePresets(next);
  };

  const myPresets = Object.keys(presets).filter(k => k.startsWith(`${patternId}/`));

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

  const cur   = getPatternById(patternId);

  // Merge static DEFAULT_PARAMS with @param annotations from library code
  const activeLibPattern = getPatternById(patternId);
  const libKnobs  = activeLibPattern?.code ? parseParamsFromCode(activeLibPattern.code) : [];
  const knobs     = (DEFAULT_PARAMS[patternId] || []).length > 0
                      ? DEFAULT_PARAMS[patternId] || []
                      : libKnobs;

  const audioIds = useMemo(() =>
    new Set(LIB_PATTERNS.filter(p => p.code && (p.code.includes('bass') || p.code.includes(' mid') || p.code.includes(' hi'))).map(p => p.id)),
    []
  );

  const handleSelectPattern = (id) => {
    onSelectPattern(id);
    setRecentIds(prev => {
      const next = [id, ...prev.filter(r => r !== id)].slice(0, 12);
      localStorage.setItem(LS_RECENT_KEY, JSON.stringify(next));
      return next;
    });
  };

  const filtered = useMemo(() => {
    if (cat === 'custom') {
      const q = search.trim().toLowerCase();
      return q ? customPatterns.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : customPatterns;
    }
    let base = showFavs ? PATTERNS.filter(p => favs.has(p.id)) : PATTERNS;
    if (cat === 'recent') {
      base = recentIds.map(id => PATTERNS.find(p => p.id === id)).filter(Boolean);
    } else if (cat === 'audio') {
      base = base.filter(p => audioIds.has(p.id));
    } else if (cat !== 'all') {
      const rule = CATEGORY_RULES[cat];
      if (Array.isArray(rule)) base = base.filter(p => rule.includes(p.id));
    }
    if (cat === 'all' && customPatterns.length > 0) base = [...customPatterns, ...base];
    const q = search.trim().toLowerCase();
    let result = q ? base.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      (p.desc && p.desc.toLowerCase().includes(q))
    ) : base;
    if (sortMode === 'alpha') result = [...result].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === 'random') result = [...result].sort(() => Math.random() - 0.5);
    return result;
  }, [search, showFavs, favs, cat, audioIds, recentIds, customPatterns, sortMode]);

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

  return (
    <div>
      <div className="lw-sec-header">
        <span>Library</span>
        <span className="meta">{PATTERNS.length + customPatterns.length} effects</span>
        <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px', marginLeft: 'auto' }}
                title="Add current pattern as a clip at the timeline playhead"
                onClick={() => {
                  const id = `clip_${Date.now()}`;
                  setShowClips(cs => [...cs, {
                    id, track: 0,
                    patternId,
                    label: PATTERNS.find(p => p.id === patternId)?.name || patternId,
                    start: timelinePlayhead,
                    end: Math.min(showDuration, timelinePlayhead + 30),
                  }]);
                }}>
          → Timeline
        </button>
      </div>

      <div style={{ padding: '0 0 6px', display: 'flex', gap: 6 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            className="lw-search-input"
            style={{ width: '100%' }}
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
          style={{ fontSize: 'var(--fs-md)', padding: '4px 8px', flexShrink: 0 }}
          title={showFavs ? 'Show all' : 'Show favorites'}
          onClick={() => setShowFavs(f => !f)}>
          ★
        </button>
        <button
          className={`btn btn-ghost ${sortMode !== 'default' ? 'active' : ''}`}
          style={{ fontSize: 'var(--fs-2xs)', padding: '4px 7px', flexShrink: 0 }}
          title="Cycle sort: default → A-Z → shuffle"
          onClick={() => setSortMode(m => m === 'default' ? 'alpha' : m === 'alpha' ? 'random' : 'default')}>
          {sortMode === 'alpha' ? 'A-Z' : sortMode === 'random' ? '⟳' : '···'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 'var(--fs-xs)', padding: '4px 8px', flexShrink: 0 }}
          title="Previous pattern"
          onClick={() => {
            const idx = PATTERNS.findIndex(p => p.id === patternId);
            const prev = PATTERNS[(idx - 1 + PATTERNS.length) % PATTERNS.length];
            handleSelectPattern(prev.id);
          }}>
          ‹
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 'var(--fs-xs)', padding: '4px 8px', flexShrink: 0 }}
          title="Next pattern"
          onClick={() => {
            const idx = PATTERNS.findIndex(p => p.id === patternId);
            const next = PATTERNS[(idx + 1) % PATTERNS.length];
            handleSelectPattern(next.id);
          }}>
          ›
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 'var(--fs-xs)', padding: '4px 8px', flexShrink: 0 }}
          title="Random pattern"
          onClick={() => {
            const pool = showFavs && favs.size > 0 ? PATTERNS.filter(p => favs.has(p.id)) : PATTERNS;
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
        {filtered.map((p, cardIdx) => (
          <div key={p.id}
               className={`lw-pattern-card ${p.id === patternId ? 'selected' : ''}`}
               onClick={() => handleSelectPattern(p.id)}
               title={p.desc || ''}>
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

      {knobs.length > 0 && (
        <>
          <div className="lw-sec-header">
            <span>{cur?.name} · params</span>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px' }}
                    onClick={() => knobs.forEach(k => onParamChange(k.name, k.value))}>
              Reset
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px' }}
                    title="Randomize all params"
                    onClick={() => knobs.forEach(k => {
                      const rand = k.min + Math.random() * (k.max - k.min);
                      onParamChange(k.name, parseFloat(rand.toFixed(k.step < 0.05 ? 3 : 2)));
                    })}>
              ⟳
            </button>
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-2xs)', padding: '1px 6px' }}
                    onClick={savePreset} title="Save current params as preset">
              + Preset
            </button>
          </div>
          <div className="lw-knobs">
            {knobs.map((k) => (
              <div className="lw-knob" key={k.name}>
                <div className="lw-knob-name">{k.name}</div>
                <input type="range"
                       min={k.min} max={k.max} step={k.step}
                       value={params[k.name] ?? k.value}
                       onChange={e => onParamChange(k.name, +e.target.value)}/>
                <div className="lw-knob-val">
                  {(params[k.name] ?? k.value).toFixed(k.step < 0.05 ? 3 : 2)}
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
                  {key.replace(`${patternId}/`, '')}
                  <span onClick={e => deletePreset(key, e)}
                        style={{ opacity: 0.5, fontSize: 'var(--fs-xs)', lineHeight: 1 }}>×</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <div className="lw-sec-header">
        <span>Palette</span>
        <span className="meta">6 colors · click to edit</span>
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
    const updateListener = EditorView.updateListener.of(update => {
      if (update.docChanged) tryCompileRef.current?.(update.state.doc.toString());
    });
    const view = new EditorView({
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
    return () => view.destroy();
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
            {liveKnobs.map((k) => (
              <div className="lw-knob" key={k.name}>
                <div className="lw-knob-name">{k.name}</div>
                <input type="range"
                       min={k.min} max={k.max} step={k.step}
                       value={params?.[k.name] ?? k.value}
                       onChange={e => onParamChange?.(k.name, +e.target.value)}/>
                <div className="lw-knob-val">
                  {(params?.[k.name] ?? k.value).toFixed(k.step < 0.05 ? 3 : 2)}
                </div>
              </div>
            ))}
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
  const { patternParams, setPatternParams, palette, setPalette } = useProject();
  const pattern = getPatternById(patternId) || PATTERNS.find(p => p.id === patternId);
  const currentParams = patternParams[patternId] || {};
  const journey = getPatternJourney(currentParams);
  const updateJourney = (patch) => {
    setPatternParams(prev => {
      const existing = prev[patternId] || {};
      const nextJourney = { ...getPatternJourney(existing), enabled: true, ...patch };
      return { ...prev, [patternId]: { ...existing, __journey: nextJourney } };
    });
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
    updateJourney({ colorStops });
  };
  const tabs = [
    { id: 'color', label: 'Color' },
    { id: 'motion', label: 'Motion' },
    { id: 'output', label: 'Output' },
  ];

  return (
    <div className="lw-graph-mode lw-builder-mode">
      <div className="lw-sec-header">
        <span>Pattern Builder</span>
        <span className="meta">{pattern?.name || patternId}</span>
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
          onChange={duration => updateJourney({ duration })}
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
              onClick={() => updateJourney({ loop: value })}
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
                <span>start to middle to end</span>
              </div>
              <div className="lw-journey-color-grid">
                {['Start', 'Middle', 'End'].map((label, index) => (
                  <label key={label}>
                    <span>{label}</span>
                    <input
                      type="color"
                      value={journey.colorStops[index]}
                      onChange={event => updateJourneyColor(index, event.target.value)}
                    />
                  </label>
                ))}
              </div>
              <BuilderSlider
                label="Blend"
                min={0}
                max={1}
                step={0.01}
                value={journey.colorMix}
                onChange={colorMix => updateJourney({ colorMix })}
                readout={`${Math.round(journey.colorMix * 100)}%`}
              />
              <BuilderSlider
                label="Sat end"
                min={0}
                max={1}
                step={0.01}
                value={journey.saturationEnd}
                onChange={saturationEnd => updateJourney({ saturationEnd })}
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
            <BuilderSlider
              label="Speed"
              min={0}
              max={4}
              step={0.01}
              value={masterSpeed}
              onChange={setMasterSpeed}
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
              onChange={speedStart => updateJourney({ speedStart })}
              readout={`${journey.speedStart.toFixed(2)}x`}
            />
            <BuilderSlider
              label="End"
              min={0}
              max={4}
              step={0.01}
              value={journey.speedEnd}
              onChange={speedEnd => updateJourney({ speedEnd })}
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
                  onClick={() => updateJourney({ easing: value })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {sel === 'output' && (
          <div className="lw-builder-block">
            <div className="lw-builder-block-head">
              <strong>Live output</strong>
              <span>applies globally</span>
            </div>
            <BuilderSlider
              label="Brightness"
              min={0}
              max={1}
              step={0.01}
              value={masterBrightness}
              onChange={setMasterBrightness}
              readout={`${Math.round(masterBrightness * 100)}%`}
            />
            <BuilderSlider
              label="Saturation"
              min={0}
              max={1}
              step={0.01}
              value={masterSaturation}
              onChange={setMasterSaturation}
              readout={`${Math.round(masterSaturation * 100)}%`}
            />
            <div className="lw-builder-action-row">
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
