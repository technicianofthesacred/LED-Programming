import { useMemo, useState } from 'react';
import { CORE_CARD_PATTERN_BANK } from '../lib/cardPatternBank.js';
import { PATTERN_LAB_GENERATOR_IDS } from '../lib/patternLabGenerators.js';

// The card's firmware only plays back the ~30 patterns in its native bank
// (LightweaverPatterns.cpp / cardPatternBank.js CORE list) by patternId +
// scalar modifiers. Everything else is honest too — it streams live from
// Studio or can be recorded — but it is not what the piece plays on its own.
const NATIVE_PATTERN_IDS = new Set(CORE_CARD_PATTERN_BANK.map(pattern => pattern.id));

const GENERATOR_LABELS = {
  particles: 'Particle Drift',
  ripple: 'Living Ripples',
  'random-walkers': 'Wandering Trails',
  'cellular-field': 'Cellular Field',
  'gray-scott-1d': 'Reaction Diffusion',
};

// The five procedural generators have no static library entry (they run a
// live simulation, not a fixed snippet), so they get a hand-picked
// approximation gradient instead of a fabricated per-tile render.
const GENERATOR_PREVIEWS = {
  particles: 'radial-gradient(circle at 30% 40%,#ffe08a 0%,transparent 6%),radial-gradient(circle at 65% 65%,#8ad9ff 0%,transparent 6%),radial-gradient(circle at 80% 25%,#ff9ecb 0%,transparent 5%),#0a0a14',
  ripple: 'radial-gradient(circle,#ffffff 0%,#00ccff 20%,#0033aa 50%,#000022 80%)',
  'random-walkers': 'linear-gradient(120deg,#0a0a14 0%,#0a0a14 40%,#7cffcb 42%,#0a0a14 44%,#0a0a14 70%,#ff9ecb 72%,#0a0a14 74%)',
  'cellular-field': 'repeating-linear-gradient(90deg,#0a0a14 0px,#0a0a14 6px,#7cff9c 6px,#7cff9c 9px)',
  'gray-scott-1d': 'radial-gradient(ellipse at 40% 50%,#ffffff 0%,#4dd2c8 25%,#0a2a3a 60%,#050510 100%)',
};

function matchesQuery(pattern, query) {
  if (!query) return true;
  const haystack = `${pattern.name} ${pattern.desc || ''}`.toLowerCase();
  return haystack.includes(query);
}

// `working` is acknowledgement, never a lock. The button keeps its handler, stays
// enabled, and is not covered by anything — the renderer is latest-wins, so tapping
// three tiles in a row is safe and must keep feeling instant. All this adds is a
// visible sign that the tap landed, for the seconds before the first frame draws.
function Tile({ id, name, preview, native, selected, working, onSelect }) {
  return (
    <button
      type="button"
      className={`plab-tile${selected ? ' is-selected' : ''}${working ? ' is-working' : ''}`}
      data-testid="pattern-lab-tile"
      data-pattern-id={id}
      data-working={working ? 'true' : undefined}
      aria-pressed={selected}
      aria-busy={working ? 'true' : undefined}
      onClick={() => onSelect(id)}
    >
      <span className="plab-tile-swatch" style={{ background: preview }} aria-hidden="true" />
      <span
        className={`plab-tile-badge${native ? ' is-native' : ''}`}
        title={native ? 'Plays on the piece' : 'Streams from Studio'}
      >
        {native ? '⚡' : '📱'}
      </span>
      <span className="plab-tile-name">{name}</span>
      {working && (
        <span className="plab-tile-working" data-testid="pattern-lab-tile-working">
          <span className="plab-tile-working-dot" aria-hidden="true" />
          <span className="sr-only">Preparing this pattern</span>
        </span>
      )}
    </button>
  );
}

function Shelf({ title, items, selectedPatternId, pendingPatternId, onSelect }) {
  if (!items.length) return null;
  return (
    <div className="plab-tile-shelf">
      <h3 className="plab-tile-shelf-title">{title}</h3>
      <div className="plab-tile-grid">
        {items.map(item => (
          <Tile
            key={item.id}
            id={item.id}
            name={item.name}
            preview={item.preview}
            native={item.native}
            selected={item.id === selectedPatternId}
            working={item.id === pendingPatternId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

export default function PatternTileBrowser({ patterns, selectedPatternId, pendingPatternId = null, onSelect }) {
  const [query, setQuery] = useState('');

  const { onPiece, more, custom } = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const buckets = { onPiece: [], more: [], custom: [] };
    for (const pattern of patterns) {
      if (!matchesQuery(pattern, normalizedQuery)) continue;
      const entry = {
        id: pattern.id,
        name: pattern.name,
        preview: pattern.preview || '#0a0a14',
        native: NATIVE_PATTERN_IDS.has(pattern.id),
      };
      if (pattern.custom) buckets.custom.push(entry);
      else if (entry.native) buckets.onPiece.push(entry);
      else buckets.more.push(entry);
    }
    return buckets;
  }, [patterns, query]);

  const living = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return PATTERN_LAB_GENERATOR_IDS
      .map(id => ({
        id: `generator:${id}`,
        name: GENERATOR_LABELS[id],
        preview: GENERATOR_PREVIEWS[id],
        native: false,
      }))
      .filter(item => !normalizedQuery || item.name.toLowerCase().includes(normalizedQuery));
  }, [query]);

  const totalResults = onPiece.length + more.length + custom.length + living.length;

  return (
    <div className="plab-tile-browser">
      <label className="plab-tile-search">
        <span className="sr-only">Search patterns</span>
        <input
          id="plab-base-pattern"
          type="search"
          inputMode="search"
          placeholder="Search patterns…"
          aria-label="Search patterns"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </label>

      {totalResults === 0 ? (
        <p className="plab-tile-empty">No patterns match “{query}”.</p>
      ) : (
        <div className="plab-tile-shelves">
          <Shelf title="On the piece" items={onPiece} selectedPatternId={selectedPatternId} pendingPatternId={pendingPatternId} onSelect={onSelect} />
          <Shelf title="More looks" items={more} selectedPatternId={selectedPatternId} pendingPatternId={pendingPatternId} onSelect={onSelect} />
          <Shelf title="Your patterns" items={custom} selectedPatternId={selectedPatternId} pendingPatternId={pendingPatternId} onSelect={onSelect} />
          <Shelf title="Living" items={living} selectedPatternId={selectedPatternId} pendingPatternId={pendingPatternId} onSelect={onSelect} />
        </div>
      )}
    </div>
  );
}
