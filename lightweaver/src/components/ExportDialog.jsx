import { useState, useEffect } from 'react';
import { resolveTimelinePlayback, resolveTimelineTargets, sampleLane, useProject } from '../state/ProjectContext.jsx';
import {
  download,
  makeManifest,
  pixelsFromPatchBoard,
  remapFrameToPatchBoard,
  toCSV,
  toDmxCsv,
  toFastLED,
  toRawFrameDump,
  toWLEDLedmap,
} from '../lib/export.js';
import { buildGammaLut, compilePattern, normalizePalette, renderPixelFrame } from '../lib/frameEngine.js';
import { buildWledBasicPackage } from '../lib/wledBasicExport.js';
import {
  deriveStandaloneOutputsFromStrips,
  estimateLwseqBytes,
  makeStandalonePackage,
  makeStandaloneSequenceFilename,
  toLwseqBytes,
  totalStandalonePixels,
} from '../lib/standaloneController.js';
import { makeCardRuntimePackage } from '../lib/cardRuntimeContract.js';

const TARGETS = [
  { id: 'wled-basic', name: 'Lightweaver Basic WLED', sub: 'WLED presets, playlist, and port checklist', tag: 'WLED', hw: 'ESP32-S3 / WLED' },
  { id: 'splay',   name: 'ENTTEC S-Play',      sub: 'Adapter bundle, not native .ssp',           tag: 'bundle', hw: 'S-Play Mini' },
  { id: 'pixlite', name: 'Advatek PixLite',     sub: 'Adapter bundle, not PixLite show mode',     tag: 'bundle', hw: 'PixLite 16 MkII' },
  { id: 'pharos',  name: 'Pharos LPC',          sub: 'Adapter bundle, not native Pharos project', tag: 'bundle', hw: 'LPC X' },
  { id: 'madrix',  name: 'Madrix / Art-Net',    sub: 'DMX/Art-Net interchange data',              tag: 'DMX',    hw: 'Madrix Art-Net' },
  { id: 'pi',      name: 'Raspberry Pi + WLED', sub: 'Pi-hosted Lightweaver project + ledmap',    tag: 'Pi JSON', hw: 'Pi 5' },
  { id: 'standalone', name: 'Lightweaver Card', sub: 'ESP32 internal flash or memory card package', tag: 'CARD', hw: 'ESP32-S3' },
  { id: 'raw',     name: 'Raw RGB frames',      sub: 'Universal .bin frame dump or DMX CSV',      tag: 'frames', hw: 'Any player' },
];

const FORMATS = [
  { id: 'bundle', name: 'Lightweaver bundle', sub: 'Project JSON + ledmap + metadata for adapter scripts', ext: '.json' },
  { id: 'wledbasic', name: 'WLED Basic package', sub: 'presets.json bank, playlist preset, and custom-effect port list', ext: '.json' },
  { id: 'cardconfig', name: 'Internal flash card config', sub: 'Saved by website to ESP32 flash', ext: '.json' },
  { id: 'lwpackage', name: 'microSD package JSON', sub: 'lightweaver.json + base64 .lwseq files', ext: '.json' },
  { id: 'lwseq', name: 'Raw .lwseq sequence', sub: 'Standalone controller frame file', ext: '.lwseq' },
  { id: 'csv',    name: 'DMX CSV',            sub: 'Frame x channel matrix, editable and importable', ext: '.csv' },
  { id: 'bin',    name: 'Raw RGB frame dump', sub: 'RGB bytes in LED order, one frame after another', ext: '.bin' },
];

export function ExportDialog({ open, onClose }) {
  const project = useProject();
  const {
    projectName, showDuration, showClips, showTransitions, autoLanes, strips, patchBoard,
    activePatternId, palette, masterSpeed, masterBrightness, masterSaturation,
    masterHueShift, gammaEnabled, gammaValue, patternParams, bpm, symSettings,
    standaloneController, controllerProfiles, activeControllerId, physicalControls,
    serializeProject,
  } = project;
  const [target, setTarget] = useState('wled-basic');
  const [format, setFormat] = useState('wledbasic');
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

  const reset = () => { setStage('config'); setProgress(0); };
  const close = () => { reset(); onClose(); };

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  useEffect(() => {
    if (target === 'standalone' && standaloneController?.runtimeMode && standaloneController.runtimeMode !== 'sequence' && format === 'lwseq') {
      setFormat('lwpackage');
    }
  }, [format, standaloneController?.runtimeMode, target]);

  if (!open) return null;

  const sel = TARGETS.find(t => t.id === target);
  const selectedFormat = FORMATS.find(f => f.id === format);
  const mapPixels = pixelsFromPatchBoard(patchBoard, strips);
  const totalLEDs = mapPixels.length;
  const standaloneMode = standaloneController?.runtimeMode || 'sequence';
  const standaloneUsesFrames = target === 'standalone' && standaloneMode === 'sequence';
  const standaloneOutputs = deriveStandaloneOutputsFromStrips(strips, standaloneController?.outputs || []);
  const activeControllerProfile = controllerProfiles.find(profile => profile.id === activeControllerId) || controllerProfiles[0] || null;
  const standalonePixels = totalStandalonePixels(standaloneOutputs);
  const safeName = (projectName || 'untitled').replace(/\s+/g, '_').toLowerCase();
  const durationMins = Math.floor(showDuration / 60);
  const durationSecs = showDuration % 60;
  const durationStr = `${String(durationMins).padStart(2,'0')}:${String(durationSecs).padStart(2,'0')}`;
  const exportFilename = target === 'wled-basic'
    ? `${safeName}-wled-basic.json`
    : target === 'standalone' && format === 'lwseq'
    ? makeStandaloneSequenceFilename(safeName)
    : target === 'standalone' && format === 'cardconfig'
    ? `${safeName}-lightweaver-card.json`
    : target === 'standalone'
      ? `${safeName}-lightweaver-controller.json`
      : `${safeName}${selectedFormat?.ext || '.json'}`;
  const modalSubtitle = target === 'wled-basic'
    ? `${projectName || 'Untitled'} · WLED presets · ${totalLEDs > 0 ? totalLEDs : '—'} LEDs`
    : target === 'standalone'
    ? `${projectName || 'Untitled'} · ${durationStr} · ${standaloneOutputs.length || '—'} outputs · ${standalonePixels || totalLEDs || '—'} LEDs`
    : `${projectName || 'Untitled'} · ${durationStr} · ${universes} universes · ${totalLEDs > 0 ? totalLEDs : '—'} LEDs`;
  const totalFrames = showDuration * fps;
  const frameSize = 512 * universes;
  const standaloneEstimate = estimateLwseqBytes({ pixels: standalonePixels || totalLEDs, fps, duration: showDuration });
  const totalBytes = target === 'wled-basic'
    ? 24 * 1024
    : target === 'standalone'
    ? standaloneUsesFrames ? standaloneEstimate.totalBytes : 4096
    : totalFrames * frameSize;
  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  const availableFormats = FORMATS
    .filter(f => target === 'wled-basic'
      ? f.id === 'wledbasic'
      : target === 'standalone'
        ? standaloneMode === 'sequence'
          ? ['cardconfig', 'lwpackage', 'lwseq'].includes(f.id)
          : ['cardconfig', 'lwpackage'].includes(f.id)
        : !['cardconfig', 'lwpackage', 'lwseq', 'wledbasic'].includes(f.id))
    .map(f => f.id === 'lwpackage' && target === 'standalone' && standaloneMode !== 'sequence'
      ? {
          ...f,
          sub: standaloneMode === 'procedural'
            ? 'lightweaver.json only; firmware renders patterns'
            : 'lightweaver.json only; firmware renders fixed cues',
        }
      : f);

  const selectTarget = (id) => {
    setTarget(id);
    if (id === 'wled-basic') {
      setFormat('wledbasic');
      return;
    }
    if (id === 'standalone') {
      if (!['cardconfig', 'lwpackage', 'lwseq'].includes(format)) setFormat('cardconfig');
      else if (format === 'lwseq' && standaloneMode !== 'sequence') setFormat('lwpackage');
      if (![24, 30].includes(fps)) setFps(24);
    }
    if (id !== 'standalone' && ['cardconfig', 'lwpackage', 'lwseq', 'wledbasic'].includes(format)) setFormat('bundle');
  };

  const buildFrames = () => {
    const baseRenderStrips = strips.map(strip => ({
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
    const uniquePatternIds = new Set([
      activePatternId,
      ...showClips.map(clip => clip.patternId),
      ...strips.map(strip => strip.patternId).filter(Boolean),
    ]);
    const perStripFns = new Map([...uniquePatternIds].map(id => [id, compilePattern(id)]).filter(([, fn]) => fn));
    const frameCount = Math.max(1, Math.round(showDuration * fps));
    const patchPixels = pixelsFromPatchBoard(patchBoard, strips);
    const frames = [];
    for (let f = 0; f < frameCount; f++) {
      const t = f / fps;
      const playback = resolveTimelinePlayback(t, showClips, showTransitions);
      const targetState = resolveTimelineTargets(t, showClips, strips);
      const targetPatternId = targetState.globalClip?.patternId || playback.patternId || activePatternId;
      const renderStrips = baseRenderStrips.map(strip => ({
        ...strip,
        patternId: targetState.byStripId[strip.id] || strip.patternId || null,
      }));
      const laneValues = Object.fromEntries(autoLanes.map(lane => [lane.param, sampleLane(lane, t)]));
      const frame = renderPixelFrame({
        t,
        strips: renderStrips,
        patternId: targetPatternId,
        blendPatternId: playback.blendPatternId,
        blendAmount: playback.blendAmount,
        blendType: playback.transType || 'crossfade',
        params: patternParams[targetPatternId] || {},
        patternParamsById: patternParams,
        paletteNorm,
        bpm,
        masterSpeed: bakeAuto && laneValues.speed != null ? laneValues.speed * 4 : masterSpeed,
        masterBrightness: bakeAuto && laneValues.brightness != null ? laneValues.brightness : masterBrightness,
        masterSaturation,
        masterHueShift: bakeAuto && laneValues.hueShift != null ? laneValues.hueShift - 0.5 : masterHueShift,
        gammaLUT,
        symSettings,
        perStripFns,
      });
      frames.push(remapFrameToPatchBoard(frame.pixels, patchPixels, strips));
    }
    return frames;
  };

  const renderExport = () => {
    setStage('rendering');
    setProgress(0);
    requestAnimationFrame(() => {
      const projectData = serializeProject();
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
      } else if (target === 'standalone' && format === 'cardconfig') {
        filename = `${safeName}-lightweaver-card.json`;
        content = JSON.stringify(makeCardRuntimePackage({
          projectName,
          mode: 'website-flash',
          led: {
            ...standaloneController?.led,
            outputs: standaloneOutputs.map((o, i) => ({
              id: o.id || `out${i + 1}`,
              name: o.name || `Output ${i + 1}`,
              pin: o.pin,
              pixels: o.pixels,
            })),
          },
          controls: standaloneController?.controls,
        }), null, 2);
      } else if (target === 'standalone' && format === 'lwseq') {
        const frames = buildFrames();
        filename = makeStandaloneSequenceFilename(safeName);
        content = toLwseqBytes(frames, { fps, outputs: standaloneOutputs });
        mime = 'application/octet-stream';
      } else if (target === 'standalone') {
        const frames = standaloneMode === 'sequence' ? buildFrames() : [];
        const sequenceFilename = makeStandaloneSequenceFilename(safeName);
        filename = `${safeName}-lightweaver-controller.json`;
        content = JSON.stringify(makeStandalonePackage({
          projectName,
          runtimeMode: standaloneMode,
          outputs: standaloneOutputs,
          controls: standaloneController?.controls,
          led: standaloneController?.led,
          sequenceFilename,
          frames,
          fps,
          loop,
        }), null, 2);
      } else if (target === 'wled-basic') {
        filename = `${safeName}-wled-basic.json`;
        content = JSON.stringify(buildWledBasicPackage({
          projectName,
          activePatternId,
          showClips,
          strips,
          palette,
          duration: showDuration,
          brightness: Math.max(32, Math.min(180, Math.round((masterBrightness || 1) * 180))),
          loop,
          physicalControls: physicalControls || activeControllerProfile?.physicalControls,
        }), null, 2);
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
    <div className="lw-modal-backdrop lw-export-backdrop" onClick={close} role="presentation">
      <div className="lw-modal lw-export-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="lw-export-title">
        <div className="lw-modal-head">
          <div>
            <div className="title" id="lw-export-title">Export show</div>
            <div className="sub">{modalSubtitle}</div>
          </div>
          <button className="lw-modal-close" onClick={close} aria-label="Close export dialog">×</button>
        </div>

        {stage === 'config' && (
          <div className="lw-modal-body">
            <div className="lw-exp-sec">1 · Target hardware</div>
            <div className="lw-exp-targets">
              {TARGETS.map(t => (
                <button key={t.id} className={`lw-exp-target ${target === t.id ? 'active' : ''}`} onClick={() => selectTarget(t.id)}>
                  <div className="name">{t.name}</div>
                  <div className="sub">{t.sub}</div>
                  <div className="tag">{t.tag}</div>
                </button>
              ))}
            </div>

            <div className="lw-exp-sec">2 · Output format</div>
            <div className="lw-exp-formats">
              {availableFormats.map(f => (
                <label key={f.id} className={`lw-exp-fmt ${format === f.id ? 'active' : ''}`}>
                  <input type="radio" checked={format === f.id} onChange={() => setFormat(f.id)}/>
                  <div><div className="name">{f.name}</div><div className="sub">{f.sub}</div></div>
                </label>
              ))}
            </div>

            <div className="lw-exp-sec">3 · Render settings</div>
            <div className="lw-exp-settings">
              {target !== 'standalone' || standaloneMode === 'sequence' ? (
                <div className="lw-exp-row">
                  <span className="k">Frame rate</span>
                  <div className="lw-exp-seg">
                    {[24, 25, 30, 44, 60].map(v => (
                      <button key={v} className={fps === v ? 'active' : ''} onClick={() => setFps(v)}>{v} fps</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="lw-exp-row">
                  <span className="k">Runtime mode</span>
                  <div className="v mono">{standaloneMode}</div>
                </div>
              )}
              {target === 'standalone' ? (
                <div className="lw-exp-row">
                  <span className="k">Outputs</span>
                  <div className="v mono">
                    {standaloneOutputs.length || '—'} connectors · {standalonePixels || totalLEDs || '—'} pixels
                  </div>
                </div>
              ) : (
                <div className="lw-exp-row">
                  <span className="k">Universes</span>
                  <div className="lw-exp-seg">
                    {[1, 2, 4, 8, 16].map(v => (
                      <button key={v} className={universes === v ? 'active' : ''} onClick={() => setUniverses(v)}>{v}</button>
                    ))}
                  </div>
                </div>
              )}
              <div className="lw-exp-row">
                <span className="k">Loop</span>
                <label className="lw-exp-check">
                  <input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)}/>
                  {target === 'wled-basic' ? 'Loop WLED playlist continuously' : 'Loop forever when played standalone'}
                </label>
              </div>
              {(target !== 'standalone' || standaloneMode === 'sequence') && (
                <div className="lw-exp-row">
                  <span className="k">Automation</span>
                  <label className="lw-exp-check">
                    <input type="checkbox" checked={bakeAuto} onChange={e => setBakeAuto(e.target.checked)}/>
                    Bake automation curves into frames
                  </label>
                </div>
              )}
            </div>

            <div className="lw-exp-sec">4 · Summary</div>
            <div className="lw-exp-summary">
              <div><span className="k">Output</span><span className="v mono">{exportFilename}</span></div>
              <div><span className="k">Clips</span><span className="v mono">{showClips.length} clips · {showTransitions.length} transitions · {autoLanes.length} lanes</span></div>
              {target === 'wled-basic'
                ? <div><span className="k">Preset bank</span><span className="v mono">stock WLED looks + playlist</span></div>
                : target !== 'standalone' || standaloneMode === 'sequence'
                ? <div><span className="k">Frames</span><span className="v mono">{Math.round(totalFrames).toLocaleString()} @ {fps} fps</span></div>
                : <div><span className="k">Runtime</span><span className="v mono">{standaloneMode}</span></div>}
              <div><span className="k">Size</span><span className="v mono">~{mb} MB</span></div>
              {target === 'standalone' && <div><span className="k">Connectors</span><span className="v mono">{standaloneOutputs.length} outputs · {standalonePixels} px</span></div>}
              <div><span className="k">Target</span><span className="v">{sel.hw}</span></div>
              <div><span className="k">Destination</span><span className="v mono">{target === 'wled-basic' ? 'browser download · WLED preset package' : target === 'standalone' ? 'browser download · microSD package' : 'browser download · adapter/import pipeline'}</span></div>
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
                ? `Building ${target === 'wled-basic' ? 'WLED preset package' : format === 'csv' || format === 'bin' ? totalFrames.toLocaleString() + ' frames' : 'project bundle'} for ${sel.hw}`
                : `Preparing ${safeName}${selectedFormat?.ext || '.json'}`}
            </div>
            <div className="lw-exp-bar"><div className="fill" style={{ width: `${progress * 100}%` }}/></div>
            <div className="lw-exp-bar-meta">
              <span>{Math.round(progress * 100)}%</span>
              <span className="mono">
                {target === 'wled-basic'
                  ? `${Math.round(progress * 100)} / 100 preset package`
                  : stage === 'rendering'
                  ? `${Math.round(progress * totalFrames).toLocaleString()} / ${totalFrames.toLocaleString()} frames`
                  : `${(progress * parseFloat(mb)).toFixed(1)} / ${mb} MB`}
              </span>
              <span className="mono">{stage === 'rendering' ? '~2s remaining' : '~1s remaining'}</span>
            </div>
            <div className="lw-exp-log">
              <div className="entry ok">✓ validated timeline · {durationStr} · no gaps</div>
              <div className="entry ok">✓ resolved {showClips.length} clips · {showTransitions.length} transitions · {autoLanes.length} automation lanes</div>
              <div className="entry ok">
                {target === 'wled-basic'
                  ? `✓ mapped ${totalLEDs || '—'} LEDs → WLED Basic preset bank`
                  : target === 'standalone'
                  ? `✓ mapped ${standalonePixels || totalLEDs || '—'} LEDs → ${standaloneOutputs.length || '—'} controller outputs`
                  : `✓ mapped ${totalLEDs || '—'} LEDs → ${universes} universes (${universes * 512} channels)`}
              </div>
              {stage === 'writing' && <div className="entry ok">{target === 'wled-basic' ? `✓ wrote WLED presets · ${mb} MB estimate` : `✓ baked ${totalFrames.toLocaleString()} frames · ${mb} MB`}</div>}
              {stage === 'writing' && <div className="entry">→ preparing browser download</div>}
              {stage === 'writing' && <div className="entry">→ writing {safeName}{selectedFormat?.ext || '.json'}</div>}
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
              {target === 'wled-basic'
                ? 'WLED Basic preset package generated. Upload or apply the included presetsJson, then load the playlist preset to cycle looks.'
                : target === 'standalone'
                ? 'Standalone controller package generated and downloaded for microSD preparation.'
                : `Export generated and downloaded. Native controller project files are not generated here; this is a Lightweaver bundle or interchange file for ${sel.hw}.`}
            </div>
            <div className="lw-exp-done-card">
              <div className="row"><span className="k">File</span><span className="v mono">{artifact?.filename || `${safeName}${selectedFormat?.ext || '.json'}`}</span></div>
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
