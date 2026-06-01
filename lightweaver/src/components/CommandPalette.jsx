import { useState, useEffect, useRef, useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';

function buildCommands(ctx, navigate) {
  const {
    newProject,
  } = ctx;

  return [
    { id: 'nav-patterns', label: 'Go to: Patterns', category: 'Navigate', action: () => navigate('patterns') },
    { id: 'nav-playlist', label: 'Go to: Playlist', category: 'Navigate', action: () => navigate('playlist') },
    { id: 'nav-layout', label: 'Go to: Layout', category: 'Navigate', action: () => navigate('layout') },
    { id: 'nav-settings', label: 'Go to: Settings', category: 'Navigate', action: () => navigate('settings') },
    { id: 'nav-flash', label: 'Go to: Flash chip', category: 'Navigate', action: () => navigate('flash') },
    { id: 'nav-installer', label: 'Go to: Installer', category: 'Navigate', action: () => navigate('installer') },
    { id: 'proj-new',    label: 'New project', category: 'Project', action: () => { if (window.confirm('Start a new project?')) newProject(); } },
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
            placeholder="Type a command..."
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
