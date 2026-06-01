import { useState, useEffect } from 'react';

const SHORTCUTS = [
  { category: 'Global',     key: '?',          desc: 'Open keyboard shortcuts' },
  { category: 'Global',     key: '⌘ K',         desc: 'Command palette' },
  { category: 'Navigation', key: '1',           desc: 'Patterns screen' },
  { category: 'Navigation', key: '2',           desc: 'Playlist screen' },
  { category: 'Navigation', key: '3',           desc: 'Layout screen' },
  { category: 'Navigation', key: '4',           desc: 'Settings screen' },
  { category: 'Navigation', key: '5',           desc: 'Flash chip screen' },
  { category: 'Navigation', key: '6',           desc: 'Installer screen' },
  { category: 'Layout',     key: 'D',           desc: 'Draw strip mode' },
  { category: 'Layout',     key: 'S',           desc: 'Select mode' },
  { category: 'Layout',     key: 'X',           desc: 'Delete selected' },
  { category: 'Layout',     key: 'Space',       desc: 'Pan mode (hold)' },
  { category: 'Layout',     key: '⌘ Z',         desc: 'Undo strip edit' },
  { category: 'Layout',     key: '⌘ ⇧ Z',       desc: 'Redo strip edit' },
];

const categories = [...new Set(SHORTCUTS.map(s => s.category))];

export function KeyboardHelp({ open, onClose }) {
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? SHORTCUTS.filter(s => s.desc.toLowerCase().includes(q) || s.key.toLowerCase().includes(q) || s.category.toLowerCase().includes(q))
    : SHORTCUTS;

  const grouped = categories.map(cat => ({
    cat,
    items: filtered.filter(s => s.category === cat),
  })).filter(g => g.items.length > 0);

  return (
    <div className="lw-modal-overlay" onClick={onClose}>
      <div className="lw-modal lw-kbd-help" onClick={e => e.stopPropagation()}>
        <div className="lw-modal-header">
          <div>
            <div className="lw-modal-title">Keyboard Shortcuts</div>
            <div className="lw-modal-sub">Press <kbd>?</kbd> to toggle · <kbd>Esc</kbd> to close</div>
          </div>
          <button className="lw-modal-close" onClick={onClose}>✕</button>
        </div>

        <input
          className="lw-search-input"
          placeholder="Search shortcuts…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
          style={{ margin: '0 0 12px' }}
        />

        <div className="lw-kbd-groups">
          {grouped.map(({ cat, items }) => (
            <div key={cat} className="lw-kbd-group">
              <div className="lw-kbd-group-title">{cat}</div>
              {items.map((s, i) => (
                <div key={i} className="lw-kbd-row">
                  <span className="lw-kbd-desc">{s.desc}</span>
                  <kbd className="lw-kbd-key">{s.key}</kbd>
                </div>
              ))}
            </div>
          ))}
          {grouped.length === 0 && (
            <div style={{ color: 'var(--text-4)', fontSize: 'var(--fs-sm)', padding: '16px 0' }}>
              No shortcuts match "{search}"
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
