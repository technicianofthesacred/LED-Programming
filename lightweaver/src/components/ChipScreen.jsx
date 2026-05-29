import { useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  DEFAULT_CARD_CONTROLS,
  DEFAULT_CARD_PATTERN_BANK,
  patchBoardToZones,
} from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { DEFAULT_STANDALONE_OUTPUTS } from '../lib/standaloneController.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';

const HOST_KEY = 'lw_chip_card_host';
const CARD_PAGE_FALLBACK = 'http://lightweaver.local/';

function readHost() {
  try { return window.localStorage.getItem(HOST_KEY) || 'lightweaver.local'; }
  catch { return 'lightweaver.local'; }
}

function hostToUrl(rawHost = '') {
  let host = String(rawHost || '').trim().toLowerCase();
  if (!host) host = 'lightweaver.local';
  if (host.startsWith('http://') || host.startsWith('https://')) return host.replace(/\/$/, '');
  if (!host.includes('.') && !/^\d+$/.test(host)) host = `${host}.local`;
  return `http://${host}`;
}

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
    patchBoard,
    setPatchBoard,
    standaloneController,
    setStandaloneController,
  } = useProject();
  const [cardHost, setCardHost] = useState(readHost);
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

  const controls = {
    ...DEFAULT_CARD_CONTROLS,
    ...(standaloneController?.controls || {}),
    encoder: {
      ...DEFAULT_CARD_CONTROLS.encoder,
      ...(standaloneController?.controls?.encoder || {}),
    },
  };

  const controllerOutputs = DEFAULT_STANDALONE_OUTPUTS.map((output, index) => ({
    ...output,
    ...((standaloneController?.outputs || [])[index] || {}),
  }));

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

  const updateZonePlayback = (patchId, patch) => {
    setPatchBoard(prev => {
      const next = normalizePatchBoard(prev, strips);
      const target = next.patches.find(item => item.id === patchId);
      if (target) target.playback = { ...(target.playback || {}), ...patch };
      return normalizePatchBoard(next, strips);
    });
  };

  const setCycleEnabled = (patternId, enabled) => {
    const current = controls.encoder.patternCycleIds || DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id);
    const next = enabled
      ? DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id).filter(id => id === patternId || current.includes(id))
      : current.filter(id => id !== patternId);
    updateController({ controls: { encoder: { patternCycleIds: next.length ? next : [patternId] } } });
  };

  const persistHost = (value) => {
    setCardHost(value);
    try { window.localStorage.setItem(HOST_KEY, value); } catch { /* quota */ }
  };

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configJson);
      setStatusKind('ok');
      setStatus('Chip config copied. Paste it into the card page.');
    } catch {
      setStatusKind('err');
      setStatus('Clipboard was blocked. Use Download chip config instead.');
    }
  };

  const directPushAvailable = typeof window !== 'undefined' && window.location.protocol !== 'https:';
  const pushDirect = async () => {
    setStatusKind('');
    setStatus(`Sending to ${hostToUrl(cardHost)}...`);
    try {
      const response = await fetch(`${hostToUrl(cardHost)}/api/config`, {
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
              Copy or download the chip config, then paste it into the card page.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={copyConfig}>Copy chip config</button>
            <button className="btn" onClick={() => downloadJson(`${safeProjectName || 'lightweaver'}-chip-config.json`, configJson)}>Download chip config</button>
            <button className="btn btn-ghost" onClick={() => window.open(hostToUrl(cardHost) || CARD_PAGE_FALLBACK, '_blank')}>Open card page</button>
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
            <Section title="Load to card" meta="reliable hosted path">
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
                  <button className="btn btn-ghost" onClick={() => window.open(hostToUrl(cardHost), '_blank')}>Open</button>
                </div>
              </FieldRow>
              <FieldRow label="Install steps">
                <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, color: 'var(--text-3)', fontSize: 'var(--fs-sm)', lineHeight: 1.5 }}>
                  <li>Copy or download the chip config from this screen.</li>
                  <li>Open the card page and go to Settings.</li>
                  <li>Paste into Paste designer config, then apply.</li>
                </ol>
              </FieldRow>
              {directPushAvailable && (
                <FieldRow label="Direct push" hint="local HTTP only">
                  <button className="btn" onClick={pushDirect}>Push directly to card</button>
                </FieldRow>
              )}
            </Section>

            <Section title="Looks on the knob" meta={`${controls.encoder.patternCycleIds?.length || DEFAULT_CARD_PATTERN_BANK.length} enabled`}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
                {DEFAULT_CARD_PATTERN_BANK.map(pattern => {
                  const enabled = (controls.encoder.patternCycleIds || []).length
                    ? controls.encoder.patternCycleIds.includes(pattern.id)
                    : true;
                  return (
                    <label key={pattern.id} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
                      <input type="checkbox" checked={enabled} onChange={event => setCycleEnabled(pattern.id, event.target.checked)} />
                      <span>{pattern.label}</span>
                    </label>
                  );
                })}
              </div>
              <FieldRow label="Knob rotate" hint="customer brightness control">
                <Segmented
                  value={controls.encoder.rotateDirection}
                  onChange={value => updateController({ controls: { encoder: { rotateDirection: value } } })}
                  options={[
                    { value: 'clockwise-brighter', label: 'Clockwise brighter' },
                    { value: 'clockwise-dimmer', label: 'Clockwise dimmer' },
                  ]}
                />
              </FieldRow>
              <FieldRow label="Brightness step" hint="one detent">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="range" min="1" max="64" step="1" value={controls.encoder.brightnessStep}
                         onChange={event => updateController({ controls: { encoder: { brightnessStep: +event.target.value } } })}
                         style={{ flex: 1 }}/>
                  <span style={{ fontFamily: 'var(--mono-font)', minWidth: 36 }}>{controls.encoder.brightnessStep}</span>
                </div>
              </FieldRow>
            </Section>

            <Section title="Zones" meta={zones.length ? `${zones.length} written` : 'default all LEDs'}>
              {zones.length === 0 ? (
                <div style={{ color: 'var(--text-3)', fontSize: 'var(--fs-sm)', lineHeight: 1.55 }}>
                  No wire zones are defined yet. The card will use the visual pattern and color from the Patterns screen across all LEDs.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {board.patches
                    .filter(patch => patch.source?.type === 'strip' && patch.output?.mode !== 'off')
                    .slice(0, 8)
                    .map(patch => {
                      const playback = patch.playback || {};
                      return (
                        <div key={patch.id} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                          <div>
                            <div style={{ color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>{patch.name || patch.id}</div>
                            <div style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--mono-font)' }}>
                              LED {patch.source.startLed} to {patch.source.endLed}
                            </div>
                          </div>
                          <select className="lw-search-input" value={playback.patternId || 'aurora'} onChange={event => updateZonePlayback(patch.id, { patternId: event.target.value })}>
                            {DEFAULT_CARD_PATTERN_BANK.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}
                          </select>
                          <input type="range" min="0" max="1" step="0.01" value={playback.brightness ?? 1}
                                 onChange={event => updateZonePlayback(patch.id, { brightness: +event.target.value })}/>
                          <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', textAlign: 'right' }}>
                            {Math.round((playback.brightness ?? 1) * 100)}%
                          </span>
                        </div>
                      );
                    })}
                </div>
              )}
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
                <span style={{ color: 'var(--text-4)' }}>Pixels</span><span style={{ fontFamily: 'var(--mono-font)' }}>{config.led.pixels}</span>
                <span style={{ color: 'var(--text-4)' }}>Outputs</span><span style={{ fontFamily: 'var(--mono-font)' }}>{config.led.outputs.length}</span>
                <span style={{ color: 'var(--text-4)' }}>Zones</span><span style={{ fontFamily: 'var(--mono-font)' }}>{config.zones.length || 1}</span>
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
