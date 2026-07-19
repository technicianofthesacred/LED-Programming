// Draw | Wire — the same `.seg` segmented-control visual as the
// toolbar's Density control (src/v3/v3-styles.css `.seg`), pinned above the
// Layout inspector. Deep-linked mode state + hash sync live in
// useLayoutCanvasInteraction.js; this component is pure JSX.
const MODES = [
  { key: 'draw', label: 'Draw' },
  { key: 'wire', label: 'Wire' },
];

export function ModeSwitch({ mode, setMode }) {
  return (
    <div className="seg la-mode-switch" data-testid="layout-mode-switch" data-mode={mode} role="group" aria-label="Layout section">
      {MODES.map(m => (
        <button
          key={m.key}
          className={mode === m.key ? 'on' : ''}
          aria-pressed={mode === m.key}
          data-testid={`layout-mode-${m.key}`}
          title={`${m.label} mode (${MODES.findIndex(x => x.key === m.key) + 1})`}
          onClick={() => setMode(m.key)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
