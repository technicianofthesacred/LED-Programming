import { PATTERN_LAB_EVOLUTION_CHARACTERS } from '../lib/patternLabEvolution.js';

const CHARACTER_LABELS = {
  'slow-bloom': 'Slow Bloom',
  wandering: 'Wandering',
  tidal: 'Tidal',
  breathing: 'Breathing',
  'gather-release': 'Gather & Release',
  'rare-surprises': 'Rare Surprises',
};

function formatTime(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export default function PatternLabEvolution({ recipe, previewTime, onEvolutionChange, onPreviewTime }) {
  const evolution = recipe?.evolution;
  const duration = evolution?.durationSeconds ?? 600;

  return (
    <section className="plab-control-section plab-evolution" aria-labelledby="plab-evolution-heading">
      <div className="plab-section-heading">
        <span className="plab-section-index">03</span>
        <div>
          <h2 id="plab-evolution-heading">Add long evolution</h2>
          <p>Let several slow clocks unfold without a short obvious loop.</p>
        </div>
      </div>

      <label className="plab-switch-row">
        <span><strong>Long Evolution</strong><small>Five to fifteen minutes</small></span>
        <input
          type="checkbox"
          checked={Boolean(evolution?.enabled)}
          disabled={!recipe}
          onChange={event => onEvolutionChange('enabled', event.target.checked)}
        />
      </label>

      <div className="plab-evolution-fields" aria-disabled={!recipe || !evolution?.enabled}>
        <label className="plab-field">
          <span>Evolution character</span>
          <select
            value={evolution?.character ?? 'slow-bloom'}
            disabled={!recipe || !evolution?.enabled}
            onChange={event => onEvolutionChange('character', event.target.value)}
          >
            {PATTERN_LAB_EVOLUTION_CHARACTERS.map(character => (
              <option key={character} value={character}>{CHARACTER_LABELS[character]}</option>
            ))}
          </select>
        </label>

        <label className="plab-macro">
          <span className="plab-macro-label"><strong>Duration</strong><output>{Math.round(duration / 60)} min</output></span>
          <input
            aria-label="Duration (minutes)"
            type="range"
            min="5"
            max="15"
            step="1"
            value={Math.round(duration / 60)}
            disabled={!recipe || !evolution?.enabled}
            onChange={event => onEvolutionChange('durationSeconds', Number(event.target.value) * 60)}
          />
        </label>

        <label className="plab-macro">
          <span className="plab-macro-label"><strong>Change</strong><output>{Math.round((evolution?.change ?? 0.35) * 100)}%</output></span>
          <input
            aria-label="Change amount"
            type="range"
            min="0"
            max="100"
            value={Math.round((evolution?.change ?? 0.35) * 100)}
            disabled={!recipe || !evolution?.enabled}
            onChange={event => onEvolutionChange('change', Number(event.target.value) / 100)}
          />
        </label>
      </div>

      <div className="plab-scrub">
        <div className="plab-scrub-heading">
          <strong>Preview the journey</strong>
          <output data-testid="pattern-lab-time">{formatTime(previewTime)} / {formatTime(duration)}</output>
        </div>
        <div className="plab-position-buttons" aria-label="Preview positions">
          <button type="button" className="btn" disabled={!recipe} onClick={() => onPreviewTime(0)}>Beginning</button>
          <button type="button" className="btn" disabled={!recipe} onClick={() => onPreviewTime(duration / 2)}>Middle</button>
          <button type="button" className="btn" disabled={!recipe} onClick={() => onPreviewTime(duration)}>End</button>
        </div>
        <input
          className="plab-time-range"
          aria-label="Preview time"
          type="range"
          min="0"
          max={duration}
          step="1"
          value={Math.min(previewTime, duration)}
          disabled={!recipe}
          onChange={event => onPreviewTime(Number(event.target.value))}
        />
      </div>
    </section>
  );
}
