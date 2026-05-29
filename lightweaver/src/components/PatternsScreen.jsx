import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { DEFAULT_CARD_CONTROLS, DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
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
import { pushConfigToCard } from '../lib/cardPushClient.js';
import { pushLivePreviewToCard } from '../lib/cardLiveControl.js';
import { LEDPreview } from './Preview.jsx';

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
  const pattern = getCardPatternById(patternId);
  const hue = cardHueToDegrees(look.customHue);
  const chroma = cardSaturationToChroma(look.customSaturation);
  return (
    <div
      className={`lw-look-preview lw-look-${patternId} ${large ? 'is-large' : ''}`}
      style={{
        '--look-preview-bg': pattern?.preview,
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

function looksMatch(a, b) {
  return a.patternId === b.patternId
    && a.brightness === b.brightness
    && a.customHue === b.customHue
    && a.customSaturation === b.customSaturation
    && a.customBreathe === b.customBreathe
    && a.customDrift === b.customDrift;
}

function LookCard({ pattern, look, previewing, saved, inCycle, onSelect, onCycleChange }) {
  const summary = previewing
    ? saved ? 'Previewing and saved as startup' : 'Previewing on LEDs'
    : saved ? 'Saved as startup' : pattern.description || 'Tap to preview this look';
  return (
    <article className={`lw-look-card ${saved ? 'is-selected' : ''} ${previewing ? 'is-previewing' : ''}`}>
      <button type="button" className="lw-look-card-main" data-pattern-id={pattern.id} onClick={onSelect}>
        <LookPreview patternId={pattern.id} look={{ ...look, patternId: pattern.id }}/>
        <span className="lw-look-card-copy">
          <strong>{pattern.label}</strong>
          <span>{summary}</span>
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
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [previewLook, setPreviewLook] = useState(() => normalizeCardVisualLook(standaloneController?.defaultLook));
  const livePreviewTimer = useRef(null);
  const livePreviewSeq = useRef(0);

  const savedLook = normalizeCardVisualLook(standaloneController?.defaultLook);
  const look = normalizeCardVisualLook(previewLook);
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
  const selectedPattern = getCardPatternById(look.patternId) || DEFAULT_CARD_PATTERN_BANK[0];
  const previewPatternId = selectedPattern?.previewPatternId || selectedPattern?.id || look.patternId;
  const savedPattern = getCardPatternById(savedLook.patternId) || DEFAULT_CARD_PATTERN_BANK[0];
  const hasUnsavedPreview = !looksMatch(look, savedLook);

  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectName, strips, patchBoard, standaloneController }),
    [projectName, strips, patchBoard, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const config = runtimePackage.config;
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

  useEffect(() => {
    setPreviewLook(savedLook);
  }, [
    savedLook.patternId,
    savedLook.brightness,
    savedLook.customHue,
    savedLook.customSaturation,
    savedLook.customBreathe,
    savedLook.customDrift,
  ]);

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

  const scheduleLivePreview = useCallback((nextLook) => {
    if (!livePreviewEnabled) return;
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    livePreviewTimer.current = setTimeout(async () => {
      setStatusKind('');
      setStatus(`Previewing ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} on ${cardHostToUrl(cardHost)}...`);
      try {
        await pushLivePreviewToCard(nextLook, { host: cardHost, timeoutMs: 2200 });
        if (sequence === livePreviewSeq.current) {
          setStatusKind('ok');
          setStatus(`Previewing ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} on the LEDs. Not saved yet.`);
        }
      } catch (error) {
        if (sequence === livePreviewSeq.current) {
          setStatusKind('err');
          setStatus(error?.reason === 'mixed-content'
            ? 'The hosted HTTPS page cannot talk directly to local HTTP hardware. Open this Studio from localhost, or copy the config to the card page.'
            : `Could not preview on the card at ${cardHostToUrl(cardHost)}.`);
        }
      }
    }, 80);
  }, [cardHost, livePreviewEnabled]);

  useEffect(() => () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
  }, []);

  const updatePreviewLook = (patch, { push = true } = {}) => {
    const nextLook = normalizeCardVisualLook({ ...look, ...patch });
    setPreviewLook(nextLook);
    if (push) scheduleLivePreview(nextLook);
  };

  const buildPackageForLook = (nextLook) => buildCardRuntimePackageFromProject({
    projectName,
    strips,
    patchBoard,
    standaloneController: {
      ...(standaloneController || {}),
      defaultLook: nextLook,
    },
  });

  const savePreviewToCard = async () => {
    const nextLook = normalizeCardVisualLook(look);
    const nextPackage = buildPackageForLook(nextLook);
    updateController({ defaultLook: nextLook });
    setStatusKind('');
    setStatus(`Saving ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} to ${cardHostToUrl(cardHost)}...`);
    try {
      await pushConfigToCard(nextPackage, { host: cardHost, timeoutMs: 6000 });
      await pushLivePreviewToCard(nextLook, { host: cardHost, timeoutMs: 2200 }).catch(() => null);
      setStatusKind('ok');
      setStatus('Saved on the card. This is now the startup look and knob cycle config.');
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? 'Saved in the Studio, but the hosted HTTPS page cannot write to the local card. Copy or download the chip config and paste it on the card page.'
        : 'Saved in the Studio, but could not reach the card. Copy or download the chip config and paste it on the card page.');
    }
  };

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
            <p>Tap patterns to try them on the LEDs first. Save to card only when the preview is the startup look you want anchored on the chip.</p>
          </div>
          <div className="lw-patterns-actions">
            <button type="button" className="btn btn-primary" onClick={savePreviewToCard}>Save to card</button>
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
              <span>Tap a pattern to preview on LEDs</span>
              <span className="meta">{DEFAULT_CARD_PATTERN_BANK.length} chip-ready / {cycleIds.length} on knob</span>
            </div>
            <div className="lw-live-preview-bar">
              <label>
                <input
                  type="checkbox"
                  checked={livePreviewEnabled}
                  onChange={event => setLivePreviewEnabled(event.target.checked)}
                />
                Preview taps on the LED card
              </label>
              <span>{hasUnsavedPreview ? 'Preview not saved' : 'Preview matches saved startup'}</span>
            </div>
            <div className="lw-look-grid">
              {DEFAULT_CARD_PATTERN_BANK.map(pattern => (
                <LookCard
                  key={pattern.id}
                  pattern={pattern}
                  look={look}
                  previewing={look.patternId === pattern.id}
                  saved={savedLook.patternId === pattern.id}
                  inCycle={cycleIds.includes(pattern.id)}
                  onSelect={() => updatePreviewLook({ patternId: pattern.id })}
                  onCycleChange={enabled => setCycleEnabled(pattern.id, enabled)}
                />
              ))}
            </div>
          </section>

          <aside className="lw-patterns-aside">
            <Section title="Preview" meta={selectedPattern?.label || look.patternId}>
              <div className="lw-pattern-led-preview" style={{ '--pattern-preview-bg': selectedPattern?.preview }}>
                <LEDPreview
                  patternId={previewPatternId}
                  playing={true}
                  speed={1}
                  glow={1.1}
                  dotSize={3.2}
                  masterBrightness={look.brightness}
                  masterSaturation={Math.max(0.2, look.customSaturation / 255)}
                  masterHueShift={Math.round((look.customHue - 32) / 2)}
                  motionSmoothing="soft"
                />
              </div>
              <p className="lw-pattern-preview-copy">{selectedPattern?.description}</p>
            </Section>

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
                    onClick={() => updatePreviewLook({ customHue: hue })}
                  />
                ))}
              </div>
              <div className="lw-look-sliders">
                <label>
                  <span>Hue</span>
                  <input type="range" min="0" max="255" step="1" value={look.customHue} onChange={event => updatePreviewLook({ customHue: +event.target.value })}/>
                </label>
                <label>
                  <span>Color</span>
                  <input type="range" min="0" max="255" step="1" value={look.customSaturation} onChange={event => updatePreviewLook({ customSaturation: +event.target.value })}/>
                </label>
                <label>
                  <span>Brightness</span>
                  <input type="range" min="0.05" max="1" step="0.01" value={look.brightness} onChange={event => updatePreviewLook({ brightness: +event.target.value })}/>
                </label>
              </div>
              <div className="lw-look-switches">
                <label><input type="checkbox" checked={look.customBreathe} onChange={event => updatePreviewLook({ customBreathe: event.target.checked })}/> Breathe</label>
                <label><input type="checkbox" checked={look.customDrift} onChange={event => updatePreviewLook({ customDrift: event.target.checked })}/> Drift</label>
              </div>
            </Section>

            <Section title="Card" meta={`${config.led.pixels} pixels`}>
              <div className="lw-card-load-summary">
                <span>Live preview</span><strong data-testid="card-live-preview-label">{selectedPattern?.label || look.patternId}</strong>
                <span>Starts with</span><strong data-testid="card-startup-label">{savedPattern?.label || savedLook.patternId}</strong>
                <span>Knob cycle</span><strong data-testid="card-knob-cycle-label">{cycleIds.map(id => getCardPatternById(id)?.label || id).join(', ')}</strong>
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
