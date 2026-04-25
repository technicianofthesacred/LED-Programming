import { useState, useEffect, useRef, useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { PATTERNS } from '../data.js';

function buildCommands(ctx, navigate) {
  const {
    setActivePatternId,
    setTimelinePlaying, timelinePlaying,
    setTimelinePlayhead,
    setBpm,
    setMasterBrightness, setMasterSpeed, setMasterSaturation,
    newProject,
    undoTimeline, redoTimeline,
    showDuration,
  } = ctx;

  return [
    // Navigation
    { id: 'nav-patterns', label: 'Go to: Pattern screen', category: 'Navigate', action: () => navigate('pattern') },
    { id: 'nav-timeline', label: 'Go to: Timeline', category: 'Navigate', action: () => navigate('timeline') },
    { id: 'nav-live',     label: 'Go to: Live screen', category: 'Navigate', action: () => navigate('live') },
    { id: 'nav-layout',  label: 'Go to: Layout', category: 'Navigate', action: () => navigate('layout') },
    { id: 'nav-devices', label: 'Go to: Devices', category: 'Navigate', action: () => navigate('devices') },
    { id: 'nav-settings',label: 'Go to: Settings', category: 'Navigate', action: () => navigate('settings') },
    { id: 'nav-export',  label: 'Go to: Export', category: 'Navigate', action: () => navigate('export') },

    // Playback
    { id: 'play-toggle', label: timelinePlaying ? 'Stop timeline' : 'Play timeline', category: 'Playback', action: () => setTimelinePlaying(p => !p) },
    { id: 'play-rewind', label: 'Rewind to start', category: 'Playback', action: () => { setTimelinePlayhead(0); setTimelinePlaying(false); } },
    { id: 'play-end',    label: 'Jump to end', category: 'Playback', action: () => setTimelinePlayhead(showDuration) },

    // Undo/Redo
    { id: 'undo', label: 'Undo', category: 'Edit', action: undoTimeline },
    { id: 'redo', label: 'Redo', category: 'Edit', action: redoTimeline },

    // Project
    { id: 'proj-new',    label: 'New project', category: 'Project', action: () => { if (window.confirm('Start a new project?')) newProject(); } },

    // Master controls
    { id: 'master-full',  label: 'Master brightness: 100%', category: 'Controls', action: () => setMasterBrightness(1) },
    { id: 'master-dim',   label: 'Master brightness: 50%',  category: 'Controls', action: () => setMasterBrightness(0.5) },
    { id: 'master-dark',  label: 'Master brightness: 10%',  category: 'Controls', action: () => setMasterBrightness(0.1) },
    { id: 'speed-1x',     label: 'Speed: 1×',               category: 'Controls', action: () => setMasterSpeed(1) },
    { id: 'speed-half',   label: 'Speed: 0.5×',             category: 'Controls', action: () => setMasterSpeed(0.5) },
    { id: 'speed-2x',     label: 'Speed: 2×',               category: 'Controls', action: () => setMasterSpeed(2) },
    { id: 'sat-full',     label: 'Saturation: 100%',         category: 'Controls', action: () => setMasterSaturation(1) },
    { id: 'sat-bw',       label: 'Saturation: 0% (grayscale)', category: 'Controls', action: () => setMasterSaturation(0) },
    { id: 'bpm-120',      label: 'BPM: 120',                 category: 'Controls', action: () => setBpm(120) },
    { id: 'bpm-140',      label: 'BPM: 140',                 category: 'Controls', action: () => setBpm(140) },
    { id: 'bpm-90',       label: 'BPM: 90',                  category: 'Controls', action: () => setBpm(90) },

    // Patterns
    ...PATTERNS.slice(0, 30).map(p => ({
      id: `pattern-${p.id}`,
      label: `Pattern: ${p.name}`,
      category: 'Pattern',
      action: () => setActivePatternId(p.id),
    })),
  ];
}

export function CommandPalette({ open, onClose, navigate }) {
  const ctx = useProject();
  const [query, setQuery] = useState('');
  const [idx, setIdx]     = useState(0);
  const inputRef          = useRef(null);

  const commands = useMemo(() => buildCommands(ctx, navigate), [ctx, navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 20);
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    ).slice(0, 12);
  }, [query, commands]);

  useEffect(() => { setIdx(0); }, [filtered]);
  useEffect(() => { if (open) { setQuery(''); setTimeout(() => inputRef.current?.focus(), 50); } }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[idx];
        if (cmd) { cmd.action(); onClose(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, filtered, idx, onClose]);

  if (!open) return null;

  const grouped = filtered.reduce((acc, cmd) => {
    if (!acc[cmd.category]) acc[cmd.category] = [];
    acc[cmd.category].push(cmd);
    return acc;
  }, {});

  let rowIdx = 0;

  return (
    <div className="lw-modal-overlay" onClick={onClose} style={{ alignItems: 'flex-start', paddingTop: '15vh' }}>
      <div style={{ width: 480, background: 'var(--surface)', border: '1px solid var(--border-2)',
                    borderRadius: 10, boxShadow: '0 24px 80px var(--shadow-strong)', overflow: 'hidden' }}
           onClick={e => e.stopPropagation()}>

        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--text-3)" strokeWidth="1.5">
            <circle cx="6" cy="6" r="4"/><line x1="9" y1="9" x2="13" y2="13"/>
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type a command or pattern name…"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none',
                     color: 'var(--text)', fontSize: 'var(--fs-md)', fontFamily: 'inherit' }}
          />
          <kbd style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-4)', border: '1px solid var(--border)', borderRadius: 3, padding: '1px 4px' }}>esc</kbd>
        </div>

        <div style={{ maxHeight: 360, overflowY: 'auto', padding: '6px 0' }}>
          {Object.entries(grouped).map(([cat, cmds]) => (
            <div key={cat}>
              <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-4)', padding: '4px 12px 2px',
                            textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {cat}
              </div>
              {cmds.map(cmd => {
                const isActive = rowIdx === idx;
                rowIdx++;
                return (
                  <button key={cmd.id}
                          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                                   padding: '8px 12px', background: isActive ? 'var(--surface-2)' : 'none',
                                   border: 'none', cursor: 'pointer', textAlign: 'left',
                                   color: 'var(--text)', fontSize: 'var(--fs-md)', borderRadius: 0 }}
                          onMouseEnter={() => setIdx(rowIdx - 1)}
                          onClick={() => { cmd.action(); onClose(); }}>
                    <span style={{ flex: 1 }}>{cmd.label}</span>
                    {isActive && (
                      <kbd style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-4)', border: '1px solid var(--border)',
                                    borderRadius: 3, padding: '1px 4px' }}>↵</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: '16px', color: 'var(--text-4)', fontSize: 'var(--fs-md)', textAlign: 'center' }}>
              No results for "{query}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
