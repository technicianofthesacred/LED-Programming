import { useState, useEffect } from 'react';

const SHORTCUTS = [
  // Global
  { category: 'Global',     key: '?',          desc: 'Open keyboard shortcuts' },
  { category: 'Global',     key: '⌘ K',         desc: 'Command palette' },
  { category: 'Global',     key: 'A',           desc: 'Toggle audio / microphone' },
  { category: 'Global',     key: '⌘ Z',         desc: 'Undo' },
  { category: 'Global',     key: '⌘ ⇧ Z',       desc: 'Redo' },
  // Pattern screen
  { category: 'Pattern',    key: 'P',           desc: 'Play / Stop preview' },
  { category: 'Pattern',    key: 'A|B',         desc: 'Toggle A/B compare mode' },
  { category: 'Pattern',    key: '⟳ button',    desc: 'Random pattern' },
  // Layout screen
  { category: 'Layout',     key: 'D',           desc: 'Draw strip mode' },
  { category: 'Layout',     key: 'S',           desc: 'Select mode' },
  { category: 'Layout',     key: 'X',           desc: 'Delete selected' },
  { category: 'Layout',     key: 'Space',       desc: 'Pan mode (hold)' },
  { category: 'Layout',     key: '⌘ Z',         desc: 'Undo strip edit' },
  { category: 'Layout',     key: '⌘ ⇧ Z',       desc: 'Redo strip edit' },
  // Timeline
  { category: 'Timeline',   key: 'Space',           desc: 'Play / Stop timeline' },
  { category: 'Timeline',   key: 'Home',            desc: 'Go to start' },
  { category: 'Timeline',   key: 'End',             desc: 'Go to end' },
  { category: 'Timeline',   key: '← →',             desc: 'Jog 1s (Shift: 10s)' },
  { category: 'Timeline',   key: 'Shift 1–9',       desc: 'Jump to cue 1–9' },
  { category: 'Timeline',   key: '⌘ Z',             desc: 'Undo timeline edit' },
  { category: 'Timeline',   key: '⌘ ⇧ Z',           desc: 'Redo timeline edit' },
  { category: 'Timeline',   key: 'Delete',          desc: 'Delete selected clip/transition' },
  { category: 'Timeline',   key: 'L',               desc: 'Clear loop region' },
  { category: 'Timeline',   key: 'Shift+drag ruler', desc: 'Set loop region' },
  { category: 'Timeline',   key: 'S',               desc: 'Split selected clip at playhead' },
  { category: 'Timeline',   key: '⌘ C',             desc: 'Copy selected clip' },
  { category: 'Timeline',   key: '⌘ V',             desc: 'Paste clip at playhead' },
  { category: 'Timeline',   key: 'Right-click ruler', desc: 'Insert cue at position' },
  { category: 'Timeline',   key: '⌘ scroll',         desc: 'Zoom in/out' },
  { category: 'Timeline',   key: 'Click BPM',        desc: 'Tap tempo' },
  // Live
  { category: 'Live',       key: 'Tab',         desc: 'Cycle through patterns' },
  { category: 'Live',       key: 'R',           desc: 'Arm / disarm recording' },
  { category: 'Live',       key: 'T',           desc: 'TAP tempo' },
  { category: 'Live',       key: '1–9',         desc: 'Fire first 9 visible patterns' },
  { category: 'Live',       key: 'B',           desc: 'Blackout — clear active pattern' },
  { category: 'Live',       key: 'F',           desc: 'Freeze — pause animation' },
  // Navigation
  { category: 'Navigation', key: '1',           desc: 'Layout screen' },
  { category: 'Navigation', key: '2',           desc: 'Pattern screen' },
  { category: 'Navigation', key: '3',           desc: 'Timeline / Show screen' },
  { category: 'Navigation', key: '4',           desc: 'Live screen' },
  { category: 'Navigation', key: '5',           desc: 'Export screen' },
  // MIDI
  { category: 'MIDI',       key: 'CC 1',        desc: 'Master speed (0–4×)' },
  { category: 'MIDI',       key: 'CC 7',        desc: 'Master brightness' },
  { category: 'MIDI',       key: 'CC 11',       desc: 'Master saturation' },
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
