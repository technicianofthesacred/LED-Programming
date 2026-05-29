import { useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  DEFAULT_CARD_PATTERN_BANK,
  patchBoardToZones,
} from '../lib/cardRuntimeContract.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import {
  deriveSectionTargets,
  normalizeSavedLooks,
  normalizeSectionVisualLook,
} from '../lib/sectionLookModel.js';
import { buildCardRuntimePackageFromProject, totalProjectPixels } from '../lib/cardRuntimeProject.js';
import { DEFAULT_STANDALONE_OUTPUTS, deriveStandaloneOutputsFromStrips } from '../lib/standaloneController.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import {
  clampHardwarePixelCount,
  clampHardwareSectionCount,
  countsFromDefaultCircleLayout,
  createDefaultCircleLayout,
  DEFAULT_CIRCLE_SECTION_COUNT,
  DEFAULT_CIRCLE_TOTAL_PIXELS,
  isDefaultCircleLayout,
} from '../lib/defaultCircleLayout.js';
import {
  cardHostToUrl,
  cardLoadMethodForProtocol,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';

const CARD_PAGE_FALLBACK = 'http://lightweaver.local/';

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
    <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)', padding: 14 }}>
      <div className="lw-sec-header" style={{ marginBottom: 12 }}>
        <span>{title}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function FieldRow({ label, hint, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '148px 1fr', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>{label}</div>
        {hint && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="lw-tweaks-seg">
      {options.map(option => (
        <button key={option.value || option} className={value === (option.value || option) ? 'active' : ''} onClick={() => onChange(option.value || option)}>
          {option.label || option}
        </button>
      ))}
    </div>
  );
}

export function ChipScreen() {
  const {
    projectName,
    strips,
    setStrips,
    viewBox,
    setViewBox,
    svgText,
    patchBoard,
    setPatchBoard,
    standaloneController,
    setStandaloneController,
  } = useProject();
  const [cardHost, setCardHost] = useState(readStoredCardHost);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');

  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const zones = useMemo(() => patchBoardToZones(board, strips), [board, strips]);
  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectName, strips, patchBoard: board, standaloneController }),
    [projectName, strips, board, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const config = runtimePackage.config;
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const activeSavedLook = savedLooks.find(look => look.id === standaloneController?.activeLookId) || savedLooks[0] || null;
  const defaultLook = normalizeSectionVisualLook(standaloneController?.defaultLook);
  const sectionTargets = useMemo(
    () => deriveSectionTargets({ strips, patchBoard: board, defaultLook }),
    [
      strips,
      board,
      defaultLook.patternId,
      defaultLook.brightness,
      defaultLook.speed,
      defaultLook.hueShift,
      defaultLook.customHue,
      defaultLook.customSaturation,
      defaultLook.customBreathe,
      defaultLook.customDrift,
    ],
  );

  const defaultLayoutActive = isDefaultCircleLayout(strips);
  const editableDefaultLayout = !svgText && (defaultLayoutActive || strips.length === 0);
  const defaultSectionCounts = defaultLayoutActive ? countsFromDefaultCircleLayout(strips) : [];
  const hardwareSectionCount = zones.length || strips.length || DEFAULT_CIRCLE_SECTION_COUNT;
  const hardwareSections = strips.length
    ? strips.map((strip, index) => ({
        id: strip.id || `section-${index + 1}`,
        name: strip.name || `Section ${index + 1}`,
        pixels: strip.pixelCount || strip.pixels?.length || 0,
      }))
    : Array.from({ length: hardwareSectionCount }, (_, index) => ({
        id: `section-${index + 1}`,
        name: index === 0 ? 'Outer circle' : index === 1 ? 'Inner circle' : `Section ${index + 1}`,
        pixels: 0,
      }));

  const configuredOutputs = standaloneController?.outputs || [];
  const layoutPixelTotal = totalProjectPixels(strips);
  const configuredOutputPixels = configuredOutputs.reduce((sum, output) => sum + Math.max(0, Math.floor(Number(output?.pixels || 0))), 0);
  const hasConfiguredOutputPixels = configuredOutputPixels > 0 && (!layoutPixelTotal || configuredOutputPixels === layoutPixelTotal);
  const outputSource = hasConfiguredOutputPixels
    ? DEFAULT_STANDALONE_OUTPUTS.map((output, index) => ({
        ...output,
        ...((configuredOutputs || [])[index] || {}),
      }))
    : deriveStandaloneOutputsFromStrips(strips, []);
  const controllerOutputs = (outputSource.length ? outputSource : DEFAULT_STANDALONE_OUTPUTS).map((output, index) => ({
    ...(DEFAULT_STANDALONE_OUTPUTS[index] || {}),
    ...output,
  }));

  const applyDefaultHardwareLayout = ({
    totalPixels = null,
    sectionCount = null,
    sectionPixelCounts = null,
  } = {}) => {
    if (!editableDefaultLayout) return;
    const currentTotal = defaultSectionCounts.reduce((sum, count) => sum + count, 0) || config.led.pixels || DEFAULT_CIRCLE_TOTAL_PIXELS;
    const nextTotal = clampHardwarePixelCount(totalPixels ?? currentTotal, currentTotal);
    const nextSectionCount = clampHardwareSectionCount(
      sectionCount ?? sectionPixelCounts?.length ?? defaultSectionCounts.length ?? DEFAULT_CIRCLE_SECTION_COUNT,
      DEFAULT_CIRCLE_SECTION_COUNT,
    );
    const nextStrips = createDefaultCircleLayout({
      totalPixels: nextTotal,
      sectionCount: nextSectionCount,
      sectionPixelCounts,
      viewBox: viewBox || '0 0 640 400',
    });
    const nextOutputs = deriveStandaloneOutputsFromStrips(nextStrips, DEFAULT_STANDALONE_OUTPUTS);

    setViewBox(viewBox || '0 0 640 400');
    setStrips(nextStrips);
    setPatchBoard(normalizePatchBoard(null, nextStrips));
    setStandaloneController(prev => {
      const current = prev || {};
      const outputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => {
        const previous = current.outputs?.[index] || {};
        const derived = nextOutputs[index];
        return {
          ...base,
          ...previous,
          ...(derived ? { id: derived.id, name: derived.name, pixels: derived.pixels } : { pixels: 0 }),
        };
      });
      return { ...current, outputs };
    });
  };

  const updateDefaultSectionPixels = (index, value) => {
    const fallbackCount = Math.max(1, Math.floor((config.led.pixels || DEFAULT_CIRCLE_TOTAL_PIXELS) / Math.max(1, hardwareSectionCount)));
    const counts = defaultSectionCounts.length
      ? [...defaultSectionCounts]
      : Array.from({ length: hardwareSectionCount }, () => fallbackCount);
    counts[index] = clampHardwarePixelCount(value, counts[index] || 1);
    applyDefaultHardwareLayout({ sectionPixelCounts: counts });
  };

  const updateController = (patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      return {
        ...current,
        ...patch,
        led: patch.led ? { ...(current.led || {}), ...patch.led } : current.led,
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

  const updateOutput = (index, patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      const outputs = DEFAULT_STANDALONE_OUTPUTS.map((output, i) => ({
        ...output,
        ...((current.outputs || [])[i] || {}),
      }));
      outputs[index] = { ...(outputs[index] || DEFAULT_STANDALONE_OUTPUTS[index]), ...patch };
      return { ...current, outputs };
    });
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
      setStatus('Clipboard was blocked. Use Download chip config instead.');
    }
  };

  const loadMethod = cardLoadMethodForProtocol(typeof window !== 'undefined' ? window.location.protocol : 'https:');
  const directPushAvailable = loadMethod.directPush;
  const pushDirect = async () => {
    setStatusKind('');
    setStatus(`Sending to ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await fetch(`${cardHostToUrl(cardHost)}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setStatusKind('ok');
      setStatus('Saved on card.');
    } catch (error) {
      setStatusKind('err');
      setStatus(`Could not reach the card. Copy or download the config and paste it on the card page.`);
    }
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 32 }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', display: 'grid', gap: 18 }}>
        <header style={{ display: 'flex', gap: 18, justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)', fontWeight: 520, color: 'var(--text)' }}>Load</h1>
            <p style={{ margin: '6px 0 0', maxWidth: 650, color: 'var(--text-3)', fontSize: 'var(--fs-md)', lineHeight: 1.55 }}>
              Copy or download the chip config, then paste it into the card page. The hosted Studio does not use pairing codes, cloud relay, or background polling.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={copyConfig}>Copy chip config</button>
            <button className="btn" onClick={() => downloadJson(`${safeProjectName || 'lightweaver'}-chip-config.json`, configJson)}>Download chip config</button>
            <button className="btn btn-ghost" onClick={() => window.open(cardHostToUrl(cardHost) || CARD_PAGE_FALLBACK, '_blank')}>Open card page</button>
          </div>
        </header>

        {status && (
          <div style={{
            padding: '10px 12px',
            border: '1px solid',
            borderColor: statusKind === 'ok' ? 'oklch(62% 0.13 150 / 0.55)' : statusKind === 'err' ? 'oklch(62% 0.18 35 / 0.62)' : 'var(--border)',
            background: statusKind === 'ok' ? 'oklch(28% 0.035 150 / 0.28)' : statusKind === 'err' ? 'oklch(28% 0.05 35 / 0.28)' : 'var(--surface)',
            borderRadius: 'var(--r-sm)',
            fontSize: 'var(--fs-sm)',
            color: 'var(--text-2)',
          }}>
            {status}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 18, alignItems: 'start' }}>
          <div style={{ display: 'grid', gap: 18 }}>
            <Section title="Load to card" meta={loadMethod.label}>
              <FieldRow label="Card page" hint="same WiFi as the card">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
                  <input
                    className="lw-search-input"
                    value={cardHost}
                    onChange={event => persistHost(event.target.value)}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder="lightweaver.local"
                  />
                  <button className="btn btn-ghost" onClick={() => window.open(cardHostToUrl(cardHost), '_blank')}>Open</button>
                </div>
              </FieldRow>
              <FieldRow label="Install steps">
                <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, color: 'var(--text-3)', fontSize: 'var(--fs-sm)', lineHeight: 1.5 }}>
                  <li>Copy or download the chip config from this screen.</li>
                  <li>Open the card page and go to Settings.</li>
                  <li>Paste into Paste designer config, then apply.</li>
                </ol>
              </FieldRow>
              {!directPushAvailable && (
                <FieldRow label="Why no push" hint="hosted HTTPS">
                  <div style={{ color: 'var(--text-3)', fontSize: 'var(--fs-sm)', lineHeight: 1.5 }}>
                    Browsers block hosted HTTPS pages from writing directly to local HTTP hardware. This screen exports the config; the card stores and runs it locally.
                  </div>
                </FieldRow>
              )}
              {directPushAvailable && (
                <FieldRow label="Direct push" hint="local HTTP only">
                  <button className="btn" onClick={pushDirect}>Push directly to card</button>
                </FieldRow>
              )}
            </Section>

            <Section title="Hardware layout" meta={`${config.led.pixels} pixels · ${hardwareSections.length || hardwareSectionCount} sections`}>
              <FieldRow
                label="Total LEDs"
                hint={editableDefaultLayout ? 'used by the default circles' : 'from the imported layout'}
              >
                <input
                  className="lw-search-input"
                  type="number"
                  min="1"
                  max="2048"
                  value={config.led.pixels}
                  disabled={!editableDefaultLayout}
                  onChange={event => applyDefaultHardwareLayout({ totalPixels: event.target.value })}
                  style={{ maxWidth: 180 }}
                />
              </FieldRow>
              <FieldRow
                label="Sections"
                hint={editableDefaultLayout ? 'zones on the chip' : 'from strips and patches'}
              >
                <input
                  className="lw-search-input"
                  type="number"
                  min="1"
                  max="8"
                  value={hardwareSections.length || hardwareSectionCount}
                  disabled={!editableDefaultLayout}
                  onChange={event => applyDefaultHardwareLayout({ sectionCount: event.target.value })}
                  style={{ maxWidth: 180 }}
                />
              </FieldRow>
              <FieldRow label="Section LEDs" hint={editableDefaultLayout ? 'inner and outer counts' : 'read from layout'}>
                <div style={{ display: 'grid', gap: 8 }}>
                  {hardwareSections.map((section, index) => (
                    <div
                      key={section.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(120px, 1fr) 112px',
                        gap: 8,
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>{section.name}</span>
                      <input
                        className="lw-search-input"
                        type="number"
                        min="1"
                        max="2048"
                        value={section.pixels}
                        disabled={!editableDefaultLayout}
                        onChange={event => updateDefaultSectionPixels(index, event.target.value)}
                        style={{ fontFamily: 'var(--mono-font)' }}
                      />
                    </div>
                  ))}
                </div>
              </FieldRow>
            </Section>

            <Section title="Sections in this load" meta={`${Math.max(0, sectionTargets.length - 1)} sections`}>
              {sectionTargets.length <= 1 ? (
                <div style={{ color: 'var(--text-3)', fontSize: 'var(--fs-sm)', lineHeight: 1.55 }}>
                  No separate sections are defined yet. The card will use the saved Look across all LEDs.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {sectionTargets.slice(1, 9).map(target => {
                    const pattern = getCardPatternById(target.look.patternId);
                    return (
                      <div key={target.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                        <div>
                          <div style={{ color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>{target.label}</div>
                          <div style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--mono-font)' }}>
                            {target.pixelCount} LEDs
                          </div>
                        </div>
                        <span style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>{pattern?.label || target.look.patternId}</span>
                        <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--mono-font)' }}>{Math.round(target.look.brightness * 100)}%</span>
                        <span style={{ color: 'var(--text-3)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--mono-font)' }}>{target.look.speed.toFixed(2)}x</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <FieldRow label="Change sections" hint="patterns and zones">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=patterns'; }}>Edit Looks</button>
                  <button className="btn btn-ghost" onClick={() => { window.location.hash = '#screen=layout'; }}>Edit Layout</button>
                </div>
              </FieldRow>
            </Section>

            <Section title="LED hardware" meta={`${config.led.pixels} pixels`}>
              <FieldRow label="Color order" hint="must match the strip">
                <Segmented
                  value={config.led.colorOrder}
                  onChange={value => updateController({ led: { colorOrder: value } })}
                  options={['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR']}
                />
              </FieldRow>
              <FieldRow label="Brightness limit" hint="firmware maximum">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="range" min="0.05" max="1" step="0.01" value={config.led.brightnessLimit}
                         onChange={event => updateController({ led: { brightnessLimit: +event.target.value } })}
                         style={{ flex: 1 }}/>
                  <span style={{ fontFamily: 'var(--mono-font)', minWidth: 44 }}>{Math.round(config.led.brightnessLimit * 100)}%</span>
                </div>
              </FieldRow>
              <FieldRow label="Outputs" hint="GPIO and pixel count">
                <div style={{ display: 'grid', gap: 8 }}>
                  {controllerOutputs.map((output, index) => (
                    <div key={output.id || index} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: 8 }}>
                      <input className="lw-search-input" value={output.name || `Output ${index + 1}`} onChange={event => updateOutput(index, { name: event.target.value })} />
                      <input className="lw-search-input" type="number" min="0" max="48" value={output.pin ?? 0} onChange={event => updateOutput(index, { pin: +event.target.value })} />
                      <input className="lw-search-input" type="number" min="0" max="2048" value={output.pixels || 0} onChange={event => updateOutput(index, { pixels: +event.target.value })} />
                    </div>
                  ))}
                </div>
              </FieldRow>
            </Section>
          </div>

          <aside style={{ display: 'grid', gap: 18, position: 'sticky', top: 24 }}>
            <Section title="What will be loaded" meta="chip package">
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 12px', fontSize: 'var(--fs-sm)' }}>
                <span style={{ color: 'var(--text-4)' }}>Piece</span><span>{config.piece.name}</span>
                <span style={{ color: 'var(--text-4)' }}>Look</span><span>{activeSavedLook?.label || 'Current saved Look'}</span>
                <span style={{ color: 'var(--text-4)' }}>Pixels</span><span style={{ fontFamily: 'var(--mono-font)' }}>{config.led.pixels}</span>
                <span style={{ color: 'var(--text-4)' }}>Outputs</span><span style={{ fontFamily: 'var(--mono-font)' }}>{config.led.outputs.length}</span>
                <span style={{ color: 'var(--text-4)' }}>Sections</span><span style={{ fontFamily: 'var(--mono-font)' }}>{config.zones.length || 1}</span>
                <span style={{ color: 'var(--text-4)' }}>Knob cycle</span><span>{config.controls.encoder.patternCycleIds.map(id => DEFAULT_CARD_PATTERN_BANK.find(pattern => pattern.id === id)?.label || id).join(', ')}</span>
              </div>
            </Section>
            <Section title="Paste config" meta={`${(configJson.length / 1024).toFixed(1)} KB`}>
              <textarea
                readOnly
                value={configJson}
                style={{ width: '100%', height: 430, resize: 'vertical', fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', lineHeight: 1.45, background: 'var(--bg)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}
              />
            </Section>
          </aside>
        </div>
      </div>
    </div>
  );
}
