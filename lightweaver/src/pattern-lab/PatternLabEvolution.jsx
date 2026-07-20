import { useEffect, useRef, useState } from 'react';
import { PATTERN_LAB_EVOLUTION_CHARACTERS } from '../lib/patternLabEvolution.js';
import { analyzeOfflineAudioWav, createOfflineAudioRequirement } from '../lib/offlineAudioLanes.js';

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

export default function PatternLabEvolution({
  recipe,
  previewTime,
  onEvolutionChange,
  onPreviewTime,
  onAudioAnalysis,
}) {
  const evolution = recipe?.evolution;
  const duration = evolution?.durationSeconds ?? 600;
  const analysisController = useRef(null);
  const [audioStatus, setAudioStatus] = useState({ state: 'idle', message: '' });

  useEffect(() => () => analysisController.current?.abort(), []);

  async function analyzeAudio(file) {
    analysisController.current?.abort();
    if (!file) return;
    const controller = new AbortController();
    analysisController.current = controller;
    setAudioStatus({ state: 'analyzing', message: `Analyzing ${file.name} on this device…` });
    try {
      const analysis = await analyzeOfflineAudioWav(file, { signal: controller.signal });
      if (analysisController.current !== controller) return;
      onAudioAnalysis?.(analysis, createOfflineAudioRequirement(analysis));
      setAudioStatus({
        state: 'ready',
        message: `${analysis.settings.durationSeconds.toFixed(1)} seconds analyzed · audio file not stored`,
      });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setAudioStatus({
        state: 'error',
        message: error instanceof Error ? error.message : 'Audio analysis failed.',
      });
    }
  }

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

      <details className="plab-advanced plab-audio-lanes">
        <summary>Offline audio lanes</summary>
        <p>Choose a WAV file to derive bass, mid, high, onset, and motion lanes. The audio stays on this device; only numbers and its fingerprint enter the recipe.</p>
        <label className="plab-field">
          <span>WAV audio file</span>
          <input
            aria-label="WAV audio file"
            type="file"
            accept="audio/wav,.wav"
            disabled={!recipe || audioStatus.state === 'analyzing'}
            onChange={event => analyzeAudio(event.target.files?.[0])}
          />
        </label>
        {recipe?.offlineAudio && (
          <button type="button" className="btn" onClick={() => {
            analysisController.current?.abort();
            onAudioAnalysis?.(null, null);
            setAudioStatus({ state: 'idle', message: 'Offline audio lanes removed.' });
          }}>Remove audio lanes</button>
        )}
        {(audioStatus.message || recipe?.offlineAudio) && (
          <p role={audioStatus.state === 'error' ? 'alert' : 'status'} data-audio-state={audioStatus.state}>
            {audioStatus.message || `Audio fingerprint ${recipe.offlineAudio.audioFingerprint.sha256.slice(0, 10)}… · Bake only`}
          </p>
        )}
      </details>
    </section>
  );
}
