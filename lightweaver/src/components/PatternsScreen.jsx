import { useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { DEFAULT_CARD_CONTROLS, DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import {
  cardHueToDegrees,
  cardSaturationToChroma,
  normalizeCardVisualLook,
} from '../lib/cardVisualLook.js';
import {
  cardHostToUrl,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';

const SWATCHES = [8, 22, 36, 54, 78, 112, 145, 172, 198, 222, 238, 252];

function downloadJson(filename, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function Section({ title, meta, children }) {
  return (
    <section className="lw-patterns-section">
      <div className="lw-sec-header">
        <span>{title}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function LookPreview({ patternId, look, large = false }) {
  const hue = cardHueToDegrees(look.customHue);
  const chroma = cardSaturationToChroma(look.customSaturation);
  return (
    <div
      className={`lw-look-preview lw-look-${patternId} ${large ? 'is-large' : ''}`}
      style={{
        '--look-hue': `${hue}deg`,
        '--look-color': `oklch(72% ${chroma} ${hue})`,
        '--look-bright': `oklch(84% ${chroma} ${hue})`,
        '--look-deep': `oklch(31% ${Math.max(0.04, Number(chroma) * 0.72).toFixed(3)} ${hue})`,
        '--look-dim': String(0.3 + look.brightness * 0.7),
      }}
      aria-hidden="true"
    >
      <span className="lw-look-orbit one"/>
      <span className="lw-look-orbit two"/>
      <span className="lw-look-scan"/>
    </div>
  );
}

function LookCard({ pattern, look, selected, inCycle, onSelect, onCycleChange }) {
  return (
    <article className={`lw-look-card ${selected ? 'is-selected' : ''}`}>
      <button type="button" className="lw-look-card-main" onClick={onSelect}>
        <LookPreview patternId={pattern.id} look={{ ...look, patternId: pattern.id }}/>
        <span className="lw-look-card-copy">
          <strong>{pattern.label}</strong>
          <span>{selected ? 'Starts when the card turns on' : 'Tap to make this the startup look'}</span>
        </span>
      </button>
      <label className="lw-look-card-toggle">
        <input type="checkbox" checked={inCycle} onChange={event => onCycleChange(event.target.checked)}/>
        <span>On knob</span>
      </label>
    </article>
  );
}

export function PatternsScreen() {
  const {
    projectName,
    strips,
    patchBoard,
    standaloneController,
    setStandaloneController,
  } = useProject();
  const [cardHost, setCardHost] = useState(readStoredCardHost);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');

  const look = normalizeCardVisualLook(standaloneController?.defaultLook);
  const controls = {
    ...DEFAULT_CARD_CONTROLS,
    ...(standaloneController?.controls || {}),
    encoder: {
      ...DEFAULT_CARD_CONTROLS.encoder,
      ...(standaloneController?.controls?.encoder || {}),
    },
  };
  const cycleIds = controls.encoder.patternCycleIds?.length
    ? controls.encoder.patternCycleIds
    : DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id);

  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectName, strips, patchBoard, standaloneController }),
    [projectName, strips, patchBoard, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const config = runtimePackage.config;
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

  const updateController = (patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      return {
        ...current,
        ...patch,
        defaultLook: patch.defaultLook
          ? normalizeCardVisualLook({ ...(current.defaultLook || {}), ...patch.defaultLook })
          : current.defaultLook,
        controls: patch.controls
          ? {
              ...(current.controls || {}),
              ...patch.controls,
              encoder: patch.controls.encoder
                ? { ...(current.controls?.encoder || {}), ...patch.controls.encoder }
                : current.controls?.encoder,
            }
          : current.controls,
      };
    });
  };

  const updateLook = (patch) => updateController({ defaultLook: patch });

  const setCycleEnabled = (patternId, enabled) => {
    const next = enabled
      ? DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id).filter(id => id === patternId || cycleIds.includes(id))
      : cycleIds.filter(id => id !== patternId);
    updateController({ controls: { encoder: { patternCycleIds: next.length ? next : [patternId] } } });
  };

  const persistHost = (value) => {
    setCardHost(value);
    writeStoredCardHost(value);
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configJson);
      setStatusKind('ok');
      setStatus('Chip config copied. Paste it into the card page on the same WiFi.');
    } catch {
      setStatusKind('err');
      setStatus('Clipboard was blocked. Download the chip config instead.');
    }
  };

  return (
    <div className="lw-patterns-screen">
      <div className="lw-patterns-shell">
        <header className="lw-patterns-hero">
          <div>
            <h1>Patterns</h1>
            <p>Choose what starts on the card, tune the color by eye, and pick the looks the knob cycles through. These choices are written to the chip config, not sent through a cloud relay.</p>
          </div>
          <div className="lw-patterns-actions">
            <button type="button" className="btn btn-primary" onClick={copyConfig}>Copy chip config</button>
            <button type="button" className="btn" onClick={() => downloadJson(`${safeProjectName || 'lightweaver'}-chip-config.json`, configJson)}>Download</button>
            <button type="button" className="btn btn-ghost" onClick={() => window.open(cardHostToUrl(cardHost), '_blank')}>Open card</button>
          </div>
        </header>

        {status && (
          <div className={`lw-chip-status ${statusKind === 'ok' ? 'is-ok' : statusKind === 'err' ? 'is-err' : ''}`}>
            {status}
          </div>
        )}

        <div className="lw-patterns-grid">
          <section className="lw-look-picker">
            <div className="lw-sec-header">
              <span>Tap a look</span>
              <span className="meta">{cycleIds.length} on knob</span>
            </div>
            <div className="lw-look-grid">
              {DEFAULT_CARD_PATTERN_BANK.map(pattern => (
                <LookCard
                  key={pattern.id}
                  pattern={pattern}
                  look={look}
                  selected={look.patternId === pattern.id}
                  inCycle={cycleIds.includes(pattern.id)}
                  onSelect={() => updateLook({ patternId: pattern.id })}
                  onCycleChange={enabled => setCycleEnabled(pattern.id, enabled)}
                />
              ))}
            </div>
          </section>

          <aside className="lw-patterns-aside">
            <Section title="Color" meta="stored on the card">
              <LookPreview patternId={look.patternId} look={look} large/>
              <div className="lw-swatch-grid" aria-label="Color swatches">
                {SWATCHES.map(hue => (
                  <button
                    key={hue}
                    className={`lw-color-swatch ${Math.abs(hue - look.customHue) <= 2 ? 'is-active' : ''}`}
                    style={{ '--swatch': `oklch(72% ${cardSaturationToChroma(look.customSaturation)} ${cardHueToDegrees(hue)})` }}
                    title={`Hue ${hue}`}
                    aria-label={`Set hue ${hue}`}
                    onClick={() => updateLook({ customHue: hue })}
                  />
                ))}
              </div>
              <div className="lw-look-sliders">
                <label>
                  <span>Hue</span>
                  <input type="range" min="0" max="255" step="1" value={look.customHue} onChange={event => updateLook({ customHue: +event.target.value })}/>
                </label>
                <label>
                  <span>Color</span>
                  <input type="range" min="0" max="255" step="1" value={look.customSaturation} onChange={event => updateLook({ customSaturation: +event.target.value })}/>
                </label>
                <label>
                  <span>Brightness</span>
                  <input type="range" min="0.05" max="1" step="0.01" value={look.brightness} onChange={event => updateLook({ brightness: +event.target.value })}/>
                </label>
              </div>
              <div className="lw-look-switches">
                <label><input type="checkbox" checked={look.customBreathe} onChange={event => updateLook({ customBreathe: event.target.checked })}/> Breathe</label>
                <label><input type="checkbox" checked={look.customDrift} onChange={event => updateLook({ customDrift: event.target.checked })}/> Drift</label>
              </div>
            </Section>

            <Section title="Card" meta={`${config.led.pixels} pixels`}>
              <div className="lw-card-load-summary">
                <span>Starts with</span><strong>{DEFAULT_CARD_PATTERN_BANK.find(pattern => pattern.id === look.patternId)?.label || look.patternId}</strong>
                <span>Knob cycle</span><strong>{cycleIds.map(id => DEFAULT_CARD_PATTERN_BANK.find(pattern => pattern.id === id)?.label || id).join(', ')}</strong>
                <span>Local page</span>
                <div className="lw-card-host-row">
                  <input
                    className="lw-search-input"
                    value={cardHost}
                    onChange={event => persistHost(event.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder="lightweaver.local"
                  />
                  <button type="button" className="btn btn-ghost" onClick={() => window.open(cardHostToUrl(cardHost), '_blank')}>Open</button>
                </div>
              </div>
            </Section>
          </aside>
        </div>
      </div>
    </div>
  );
}
