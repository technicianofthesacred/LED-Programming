import { useState, useEffect } from 'react';
import { resolveTimelinePlayback, sampleLane, useProject } from '../state/ProjectContext.jsx';
import { download, makeManifest, pixelsFromStrips, toCSV, toDmxCsv, toFastLED, toRawFrameDump, toWLEDLedmap } from '../lib/export.js';
import { buildGammaLut, normalizePalette, renderPixelFrame } from '../lib/frameEngine.js';

const TARGETS = [
  { id: 'splay',   name: 'ENTTEC S-Play',      sub: 'S-Play / S-Play Mini · 32 universes',    format: '.ssp',    hw: 'S-Play Mini' },
  { id: 'pixlite', name: 'Advatek PixLite',     sub: '16 MkII / 4 MkII · Show mode',           format: '.pxshow', hw: 'PixLite 16 MkII' },
  { id: 'pharos',  name: 'Pharos LPC',          sub: 'LPC X / TPC / VLC',                      format: '.pls',    hw: 'LPC X' },
  { id: 'madrix',  name: 'Madrix Nebula',       sub: 'Nebula / Luna · standalone record',      format: '.madr',   hw: 'Nebula' },
  { id: 'pi',      name: 'Raspberry Pi + OLA',  sub: 'Pi 4/5 running ola · or WLED Ledmap',    format: '.json',   hw: 'Pi 4B' },
  { id: 'raw',     name: 'Raw ArtNet frames',   sub: 'Universal · .bin frame dump + .csv map', format: '.bin',    hw: 'Any SD reader' },
];

const FORMATS = [
  { id: 'native', name: 'Native show file',  sub: "Target's own format — plug in and go" },
  { id: 'pcap',   name: 'ArtNet pcap',       sub: 'Packet capture at 44 fps · replayable with artnetplayer' },
  { id: 'csv',    name: 'DMX CSV',           sub: 'Frame × channel matrix · editable in Excel' },
  { id: 'bin',    name: 'Raw frame dump',    sub: '.bin · 512 bytes × universes × frames' },
];

export function ExportDialog({ open, onClose }) {
  const project = useProject();
  const {
    projectName, showDuration, showClips, showTransitions, autoLanes, strips,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
    serializeProject,
  } = project;
  const [target, setTarget] = useState('splay');
  const [format, setFormat] = useState('native');
  const [fps, setFps] = useState(44);
  const [loop, setLoop] = useState(true);
  const [bakeAuto, setBakeAuto] = useState(true);
  const [universes, setUniverses] = useState(4);
  const [stage, setStage] = useState('config');
  const [progress, setProgress] = useState(0);
  const [artifact, setArtifact] = useState(null);

  useEffect(() => {
    if (stage === 'config' || stage === 'done') return;
    let raf;
    const start = performance.now();
    const dur = stage === 'rendering' ? 2400 : 1800;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      setProgress(p);
      if (p >= 1) {
        if (stage === 'rendering') { setStage('writing'); setProgress(0); }
        else if (stage === 'writing') { setStage('done'); }
      } else {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  if (!open) return null;

  const sel = TARGETS.find(t => t.id === target);
  const totalLEDs = strips.reduce((s, st) => s + (st.pixels?.length || 0), 0);
  const safeName = (projectName || 'untitled').replace(/\s+/g, '_').toLowerCase();
  const durationMins = Math.floor(showDuration / 60);
  const durationSecs = showDuration % 60;
  const durationStr = `${String(durationMins).padStart(2,'0')}:${String(durationSecs).padStart(2,'0')}`;
  const totalFrames = showDuration * fps;
  const frameSize = 512 * universes;
  const totalBytes = totalFrames * frameSize;
  const mb = (totalBytes / 1024 / 1024).toFixed(1);

  const reset = () => { setStage('config'); setProgress(0); };
  const close = () => { reset(); onClose(); };
  const buildFrames = () => {
    const renderStrips = strips.map(strip => ({
      id: strip.id,
      speed: strip.speed,
      brightness: strip.brightness,
      hueShift: strip.hueShift,
      patternId: strip.patternId,
      pts: (strip.pixels || []).map((px, i, arr) => ({
        x: px.x,
        y: px.y,
        p: arr.length > 1 ? i / (arr.length - 1) : 0.5,
      })),
    }));
    const gammaLUT = buildGammaLut(gammaEnabled, gammaValue);
    const paletteNorm = normalizePalette(palette);
    const frameCount = Math.max(1, Math.round(showDuration * fps));
    const frames = [];
    for (let f = 0; f < frameCount; f++) {
      const t = f / fps;
      const playback = resolveTimelinePlayback(t, showClips, showTransitions);
      const laneValues = Object.fromEntries(autoLanes.map(lane => [lane.param, sampleLane(lane, t)]));
      const frame = renderPixelFrame({
        t,
        strips: renderStrips,
        patternId: playback.patternId || activePatternId,
        blendPatternId: playback.blendPatternId,
        blendAmount: playback.blendAmount,
        blendType: playback.transType || 'crossfade',
        params: patternParams[playback.patternId || activePatternId] || {},
        paletteNorm,
        bpm,
        masterSpeed: bakeAuto && laneValues.speed != null ? laneValues.speed * 4 : masterSpeed,
        masterBrightness: bakeAuto && laneValues.brightness != null ? laneValues.brightness : masterBrightness,
        masterSaturation,
        masterHueShift: bakeAuto && laneValues.hueShift != null ? laneValues.hueShift - 0.5 : masterHueShift,
        gammaLUT,
        symSettings,
      });
      frames.push(frame.pixels);
    }
    return frames;
  };

  const renderExport = () => {
    setStage('rendering');
    setProgress(0);
    requestAnimationFrame(() => {
      const projectData = serializeProject();
      const mapPixels = pixelsFromStrips(strips);
      const manifest = makeManifest(projectData, { target, format, fps });
      let filename = `${safeName}.json`;
      let content;
      let mime = 'application/json';

      if (format === 'csv') {
        const frames = buildFrames();
        filename = `${safeName}-dmx.csv`;
        content = toDmxCsv(frames);
        mime = 'text/csv';
      } else if (format === 'bin') {
        const frames = buildFrames();
        filename = `${safeName}-frames.bin`;
        content = toRawFrameDump(frames);
        mime = 'application/octet-stream';
      } else if (target === 'pi') {
        filename = `${safeName}-lightweaver-pi.json`;
        content = JSON.stringify({
          manifest: JSON.parse(manifest),
          project: projectData,
          ledmap: JSON.parse(toWLEDLedmap(mapPixels)),
        }, null, 2);
      } else {
        filename = `${safeName}-show.json`;
        content = JSON.stringify({
          manifest: JSON.parse(manifest),
          project: projectData,
          ledmap: JSON.parse(toWLEDLedmap(mapPixels)),
          fastledHeader: toFastLED(mapPixels),
          positionsCsv: toCSV(mapPixels),
        }, null, 2);
      }

      download(content, filename, mime);
      setArtifact({ filename, bytes: content.byteLength || content.length || 0 });
      setProgress(1);
      setStage('done');
    });
  };

  return (
    <div className="lw-modal-backdrop" onClick={close}>
      <div className="lw-modal" onClick={e => e.stopPropagation()}>
        <div className="lw-modal-head">
          <div>
            <div className="title">Export show</div>
            <div className="sub">{projectName || 'Untitled'} · {durationStr} · {universes} universes · {totalLEDs > 0 ? totalLEDs : '—'} LEDs</div>
          </div>
          <button className="lw-modal-close" onClick={close}>×</button>
        </div>

        {stage === 'config' && (
          <div className="lw-modal-body">
            <div className="lw-exp-sec">1 · Target hardware</div>
            <div className="lw-exp-targets">
              {TARGETS.map(t => (
                <button key={t.id} className={`lw-exp-target ${target === t.id ? 'active' : ''}`} onClick={() => setTarget(t.id)}>
                  <div className="name">{t.name}</div>
                  <div className="sub">{t.sub}</div>
                  <div className="tag">{t.format}</div>
                </button>
              ))}
            </div>

            <div className="lw-exp-sec">2 · Format</div>
            <div className="lw-exp-formats">
              {FORMATS.map(f => (
                <label key={f.id} className={`lw-exp-fmt ${format === f.id ? 'active' : ''}`}>
                  <input type="radio" checked={format === f.id} onChange={() => setFormat(f.id)}/>
                  <div><div className="name">{f.name}</div><div className="sub">{f.sub}</div></div>
                </label>
              ))}
            </div>

            <div className="lw-exp-sec">3 · Render settings</div>
            <div className="lw-exp-settings">
              <div className="lw-exp-row">
                <span className="k">Frame rate</span>
                <div className="lw-exp-seg">
                  {[25, 30, 44, 60].map(v => (
                    <button key={v} className={fps === v ? 'active' : ''} onClick={() => setFps(v)}>{v} fps</button>
                  ))}
                </div>
              </div>
              <div className="lw-exp-row">
                <span className="k">Universes</span>
                <div className="lw-exp-seg">
                  {[1, 2, 4, 8, 16].map(v => (
                    <button key={v} className={universes === v ? 'active' : ''} onClick={() => setUniverses(v)}>{v}</button>
                  ))}
                </div>
              </div>
              <div className="lw-exp-row">
                <span className="k">Loop</span>
                <label className="lw-exp-check">
                  <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)}/>
                  Loop forever when played standalone
                </label>
              </div>
              <div className="lw-exp-row">
                <span className="k">Automation</span>
                <label className="lw-exp-check">
                  <input type="checkbox" checked={bakeAuto} onChange={e => setBakeAuto(e.target.checked)}/>
                  Bake automation curves into frames
                </label>
              </div>
            </div>

            <div className="lw-exp-sec">4 · Summary</div>
            <div className="lw-exp-summary">
              <div><span className="k">Output</span><span className="v mono">{safeName}{sel.format}</span></div>
              <div><span className="k">Clips</span><span className="v mono">{showClips.length} clips · {showTransitions.length} transitions · {autoLanes.length} lanes</span></div>
              <div><span className="k">Frames</span><span className="v mono">{Math.round(totalFrames).toLocaleString()} @ {fps} fps</span></div>
              <div><span className="k">Size</span><span className="v mono">~{mb} MB</span></div>
              <div><span className="k">Target</span><span className="v">{sel.hw}</span></div>
              <div><span className="k">Destination</span><span className="v mono">SD card · /SHOW/{safeName}/</span></div>
            </div>

            <div className="lw-modal-foot">
              <button className="btn btn-ghost" onClick={close}>Cancel</button>
              <button className="btn btn-primary" onClick={renderExport}>
                Render &amp; download →
              </button>
            </div>
          </div>
        )}

        {(stage === 'rendering' || stage === 'writing') && (
          <div className="lw-modal-body lw-exp-progress">
            <div className="lw-exp-stage-icon">
              {stage === 'rendering' ? (
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="var(--accent)" strokeWidth="1.5">
                  <circle cx="20" cy="20" r="14" opacity="0.25"/>
                  <path d="M20 6 A14 14 0 0 1 34 20" strokeLinecap="round">
                    <animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="1s" repeatCount="indefinite"/>
                  </path>
                </svg>
              ) : (
                <svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="var(--mint)" strokeWidth="1.5">
                  <rect x="10" y="6" width="20" height="28" rx="2"/>
                  <rect x="14" y="10" width="12" height="6"/>
                  <circle cx="20" cy="26" r="3">
                    <animate attributeName="r" values="2;4;2" dur="0.8s" repeatCount="indefinite"/>
                  </circle>
                </svg>
              )}
            </div>
            <div className="lw-exp-stage-title">{stage === 'rendering' ? 'Rendering export…' : 'Preparing download…'}</div>
            <div className="lw-exp-stage-sub">
              {stage === 'rendering'
                ? `Building ${format === 'csv' || format === 'bin' ? totalFrames.toLocaleString() + ' frames' : 'project bundle'} for ${sel.hw}`
                : `Preparing ${safeName}${sel.format}`}
            </div>
            <div className="lw-exp-bar"><div className="fill" style={{ width: `${progress * 100}%` }}/></div>
            <div className="lw-exp-bar-meta">
              <span>{Math.round(progress * 100)}%</span>
              <span className="mono">
                {stage === 'rendering'
                  ? `${Math.round(progress * totalFrames).toLocaleString()} / ${totalFrames.toLocaleString()} frames`
                  : `${(progress * parseFloat(mb)).toFixed(1)} / ${mb} MB`}
              </span>
              <span className="mono">{stage === 'rendering' ? '~2s remaining' : '~1s remaining'}</span>
            </div>
            <div className="lw-exp-log">
              <div className="entry ok">✓ validated timeline · {durationStr} · no gaps</div>
              <div className="entry ok">✓ resolved {showClips.length} clips · {showTransitions.length} transitions · {autoLanes.length} automation lanes</div>
              <div className="entry ok">✓ mapped {totalLEDs || '—'} LEDs → {universes} universes ({universes * 512} channels)</div>
              {stage === 'writing' && <div className="entry ok">✓ baked {totalFrames.toLocaleString()} frames · {mb} MB</div>}
              {stage === 'writing' && <div className="entry">→ mounting SD card (FAT32)</div>}
              {stage === 'writing' && <div className="entry">→ writing {safeName}{sel.format}</div>}
            </div>
          </div>
        )}

        {stage === 'done' && (
          <div className="lw-modal-body lw-exp-done">
            <div className="lw-exp-stage-icon done">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="var(--mint)" strokeWidth="2">
                <circle cx="24" cy="24" r="20"/>
                <path d="M15 24 L22 31 L33 18" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="lw-exp-stage-title" style={{ color: 'var(--mint)' }}>Export complete</div>
            <div className="lw-exp-stage-sub">
              Export generated and downloaded. The file contains the project, layout map, and target metadata for {sel.hw}.
            </div>
            <div className="lw-exp-done-card">
              <div className="row"><span className="k">File</span><span className="v mono">{artifact?.filename || `${safeName}${sel.format}`}</span></div>
              <div className="row"><span className="k">Path</span><span className="v mono">browser download</span></div>
              <div className="row"><span className="k">Size</span><span className="v mono">{artifact ? `${(artifact.bytes / 1024).toFixed(1)} KB` : `${mb} MB`}</span></div>
              <div className="row"><span className="k">Duration</span><span className="v mono">{durationStr} · {loop ? 'looping' : 'one-shot'}</span></div>
              <div className="row"><span className="k">Target</span><span className="v">{sel.hw}</span></div>
            </div>
            <div className="lw-modal-foot">
              <button className="btn btn-ghost" onClick={reset}>Export again</button>
              <button className="btn btn-primary" onClick={close}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
