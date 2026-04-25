import { useRef } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { useTweaks } from './Tweaks.jsx';
import { PALETTE_DEFAULT } from '../data.js';

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="lw-sec-header"><span>{title}</span></div>
      {children}
    </div>
  );
}

function Row({ label, hint, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 'var(--fs-md)', color: 'var(--text)' }}>{label}</div>
        {hint && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', marginTop: 2 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const WLED_FPS_OPTIONS = [10, 20, 25, 30, 40, 50];
const GAMMA_PRESETS = [{ label: '1.0 (linear)', v: 1.0 }, { label: '2.0', v: 2.0 }, { label: '2.2 (sRGB)', v: 2.2 }, { label: '2.5', v: 2.5 }];

export function SettingsScreen() {
  const {
    projectName, setProjectName,
    bpm, setBpm,
    palette, setPalette,
    masterSpeed, setMasterSpeed,
    masterBrightness, setMasterBrightness,
    masterSaturation, setMasterSaturation,
    gammaEnabled, setGammaEnabled,
    gammaValue, setGammaValue,
    masterHueShift, setMasterHueShift,
    showDuration, setShowDuration,
    serializeProject, loadProject, newProject, lastSaved,
  } = useProject();

  const { tweaks, set } = useTweaks();
  const importRef = useRef(null);

  const handleDownload = () => {
    const data = serializeProject();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(projectName || 'project').replace(/[^a-z0-9]/gi, '-').toLowerCase()}.lwproj.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!loadProject(data)) alert('Invalid project file');
      } catch { alert('Could not parse file'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const durationMins = Math.floor(showDuration / 60);
  const durationSecs = showDuration % 60;

  return (
    <div className="lw-settings-screen">
      <div className="lw-settings-inner">
        <h2 style={{ fontSize: 'var(--fs-xl)', fontWeight: 500, marginBottom: 24, color: 'var(--text)' }}>Settings</h2>

        <Section title="Project">
          <Row label="Project name">
            <input
              className="lw-search-input"
              style={{ width: '100%' }}
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="Untitled Project"
            />
          </Row>
          <Row label="Default BPM" hint="Used for beat-quantized clip recording">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min="20" max="300" step="1" value={bpm}
                     onChange={e => setBpm(+e.target.value)} style={{ flex: 1 }}/>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', minWidth: 40 }}>{bpm}</span>
            </div>
          </Row>
          <Row label="Show duration" hint="Total timeline length">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="number" min="60" max="7200" step="30" value={showDuration}
                     onChange={e => setShowDuration(+e.target.value)}
                     className="lw-search-input" style={{ width: 80 }}/>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>
                = {durationMins}m {durationSecs}s
              </span>
            </div>
          </Row>
        </Section>

        <Section title="Palette">
          <div style={{ height: 8, borderRadius: 4, marginBottom: 10,
                        background: `linear-gradient(90deg, ${(palette || PALETTE_DEFAULT).join(', ')})` }}/>
          <Row label="Pattern palette" hint="Used by all patterns that read palette[]">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {(palette || PALETTE_DEFAULT).map((c, i) => (
                <label key={i} style={{ position: 'relative', cursor: 'pointer' }}>
                  <div style={{ width: 28, height: 28, borderRadius: 4, background: c,
                                border: '2px solid var(--border-2)', cursor: 'pointer' }}/>
                  <input type="color" value={c}
                         style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
                         onChange={e => {
                           const next = [...(palette || PALETTE_DEFAULT)];
                           next[i] = e.target.value;
                           setPalette(next);
                         }}/>
                </label>
              ))}
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                      onClick={() => setPalette(PALETTE_DEFAULT)}>
                Reset
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                      title="Copy palette as CSS custom properties"
                      onClick={() => {
                        const css = (palette || PALETTE_DEFAULT).map((c, i) => `  --pal-${i}: ${c};`).join('\n');
                        navigator.clipboard?.writeText(`:root {\n${css}\n}`);
                      }}>
                CSS
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                      title="Copy palette as hex list"
                      onClick={() => {
                        navigator.clipboard?.writeText((palette || PALETTE_DEFAULT).join(', '));
                      }}>
                Hex
              </button>
            </div>
          </Row>
          <Row label="Add color" hint="Expand palette">
            <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                    onClick={() => setPalette(p => [...(p || PALETTE_DEFAULT), '#ffffff'])}>
              + Color
            </button>
            {(palette || PALETTE_DEFAULT).length > 1 && (
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                      onClick={() => setPalette(p => (p || PALETTE_DEFAULT).slice(0, -1))}>
                – Last
              </button>
            )}
          </Row>
        </Section>

        <Section title="Appearance">
          <Row label="Theme">
            <div className="lw-tweaks-seg">
              {['dark', 'darker', 'light'].map(t => (
                <button key={t}
                        className={tweaks.theme === t ? 'active' : ''}
                        onClick={() => set('theme', t)}>
                  {t}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Accent color">
            <div className="lw-tweaks-seg">
              {['blue', 'violet', 'mint', 'orange'].map(c => (
                <button key={c}
                        className={tweaks.accent === c ? 'active' : ''}
                        onClick={() => set('accent', c)}>
                  {c}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Rendering">
          <Row label="Master speed default">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min="0" max="4" step="0.05" value={masterSpeed}
                     onChange={e => setMasterSpeed(+e.target.value)} style={{ flex: 1 }}/>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', minWidth: 40 }}>{masterSpeed.toFixed(2)}×</span>
            </div>
          </Row>
          <Row label="Master brightness">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min="0" max="1" step="0.01" value={masterBrightness}
                     onChange={e => setMasterBrightness(+e.target.value)} style={{ flex: 1 }}/>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', minWidth: 40 }}>{Math.round(masterBrightness * 100)}%</span>
            </div>
          </Row>
          <Row label="Master saturation">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min="0" max="1" step="0.01" value={masterSaturation}
                     onChange={e => setMasterSaturation(+e.target.value)} style={{ flex: 1 }}/>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', minWidth: 40 }}>{Math.round(masterSaturation * 100)}%</span>
            </div>
          </Row>
          <Row label="Master hue shift" hint="Rotates all colors on the wheel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="range" min="-0.5" max="0.5" step="0.01" value={masterHueShift}
                     onChange={e => setMasterHueShift(+e.target.value)} style={{ flex: 1 }}/>
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-md)', minWidth: 50 }}>
                {masterHueShift >= 0 ? '+' : ''}{Math.round(masterHueShift * 360)}°
              </span>
              {masterHueShift !== 0 && (
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => setMasterHueShift(0)}>Reset</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
              {[
                { label: '❄ Cool', value: -0.08 },
                { label: '⚪ Neutral', value: 0 },
                { label: '🔥 Warm', value: 0.06 },
                { label: '🌸 Pink', value: -0.12 },
                { label: '💚 Green', value: 0.18 },
              ].map(p => (
                <button key={p.label} className={`btn btn-ghost ${Math.abs(masterHueShift - p.value) < 0.01 ? 'active' : ''}`}
                        style={{ fontSize: 'var(--fs-2xs)', padding: '2px 7px' }}
                        onClick={() => setMasterHueShift(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label="Gamma correction" hint="Corrects LED brightness curve">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={gammaEnabled} onChange={e => setGammaEnabled(e.target.checked)}/>
              {GAMMA_PRESETS.map(p => (
                <button key={p.v}
                        className={`btn btn-ghost ${gammaEnabled && Math.abs(gammaValue - p.v) < 0.05 ? 'active' : ''}`}
                        style={{ fontSize: 'var(--fs-xs)', padding: '2px 7px' }}
                        disabled={!gammaEnabled}
                        onClick={() => setGammaValue(p.v)}>
                  {p.label}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Performance">
          <Row label="Canvas resolution" hint="Lower = faster rendering">
            <div className="lw-tweaks-seg">
              {[0.5, 0.75, 1.0, 1.5, 2.0].map(r => (
                <button key={r}
                        className={tweaks.dpr === r ? 'active' : ''}
                        onClick={() => set('dpr', r)}>
                  {r}×
                </button>
              ))}
            </div>
          </Row>
          <Row label="WLED push fps" hint="Max frames per second sent to hardware">
            <div className="lw-tweaks-seg">
              {WLED_FPS_OPTIONS.map(fps => (
                <button key={fps}
                        className={tweaks.wledFps === fps ? 'active' : ''}
                        onClick={() => set('wledFps', fps)}>
                  {fps}
                </button>
              ))}
            </div>
          </Row>
        </Section>

        <Section title="Project File">
          <Row label="Save project" hint="Download .lwproj.json file">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-sm)' }} onClick={handleDownload}>
                ↓ Download
              </button>
              {lastSaved && (
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
                  Auto-saved {new Date(lastSaved).toLocaleTimeString()}
                </span>
              )}
            </div>
          </Row>
          <Row label="Load project" hint="Import a .lwproj.json file">
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-sm)' }}
                      onClick={() => importRef.current?.click()}>
                ↑ Import
              </button>
              <input ref={importRef} type="file" accept=".json,.lwproj.json" style={{ display: 'none' }}
                     onChange={handleImport}/>
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-sm)' }}
                      onClick={() => { if (window.confirm('Discard all changes and start a new project?')) newProject(); }}>
                New project
              </button>
            </div>
          </Row>
        </Section>

        <Section title="About">
          <div style={{ fontSize: 'var(--fs-md)', color: 'var(--text-3)', lineHeight: 1.8 }}>
            <div>Lightweaver · LED installation controller</div>
            <div>Pattern engine: per-pixel JS sandbox · WLED WebSocket push</div>
            <div>Hardware: ESP32-S3 N16R8 · WS2812B strips</div>
          </div>
        </Section>
      </div>
    </div>
  );
}
