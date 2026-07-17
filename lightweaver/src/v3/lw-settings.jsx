/* Light Weaver v3 — Settings screen */
/* Exact mockup file, converted from window-global script to ES module, now
   wired to the live ProjectContext + card handlers.

   The six mockup cards keep their exact visual structure and classes
   (.card.set-card / .set-row / .set-k / .set-v / .mini-seg / .set-range /
   .set-pal etc). Only the data source changed: local sample useState became
   real state and handlers. Below the six cards, the live-only EXTRA function
   (card connection, project library, ring summary, hardware layout editor,
   advanced JSON, autosave, and the relocated encoder controls) is appended as
   additional .card.set-card sections in the same mockup idiom so it reads as
   native, not bolted on. */
import React, { createContext, useContext, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { I, SWATCHES } from './lw-shared.jsx';
import { useProject } from '../state/ProjectContext.jsx';
import { useTweaks } from '../components/Tweaks.jsx';
import { MOTION_SMOOTHING_MODES } from '../lib/motionSmoothing.js';
import { STANDALONE_RUNTIME_MODES, DEFAULT_STANDALONE_OUTPUTS } from '../lib/standaloneController.js';
import { patchBoardToZones } from '../lib/cardRuntimeContract.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import {
  deriveSectionTargets,
  normalizeSavedLooks,
  normalizeSectionVisualLook,
} from '../lib/sectionLookModel.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import {
  clampHardwarePixelCount,
  clampHardwareSectionCount,
  countsFromDefaultCircleLayout,
  createDefaultCircleLayout,
  DEFAULT_CIRCLE_SECTION_LIMIT,
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
import { buildCardConfigHandoffUrl, cardStorageJson, pushConfigToCard } from '../lib/cardPushClient.js';
import { pushLiveHardwareToCard } from '../lib/cardLiveControl.js';
import { downloadJsonFile } from '../lib/downloadFile.js';
import {
  createProjectLibraryRecord,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
  listProjectLibraryRecords,
  PROJECT_LIBRARY_CHANGED_EVENT,
  readActiveProjectLibraryRecordId,
  saveProjectLibraryRecord,
  writeActiveProjectLibraryRecordId,
} from '../lib/projectStorage.js';
import { cardActionReducer, createCardActionState } from '../lib/cardAction.js';

const CARD_PAGE_FALLBACK = 'http://lightweaver.local/';
const SettingsFieldContext = createContext(null);

  function Row({ label, hint, stack, children }) {
    const reactId = useId();
    const field = { controlId: `${reactId}-control`, labelId: `${reactId}-label`, label };
    return (
      <div className={"set-row" + (stack ? " stack" : "")}>
        <div className="set-k"><span className="kk" id={field.labelId}>{label}</span>{hint && <span className="hh">{hint}</span>}</div>
        <div className="set-v"><SettingsFieldContext.Provider value={field}>{children}</SettingsFieldContext.Provider></div>
      </div>
    );
  }
  function Seg({ opts, val, set }) {
    const field = useContext(SettingsFieldContext);
    return (
      <div className="mini-seg" role="group" aria-labelledby={field?.labelId}>
        {opts.map((o) => <button type="button" key={o} className={val === o ? "on" : ""} aria-pressed={val === o} onClick={() => set(o)}>{o}</button>)}
      </div>
    );
  }
  function Range({ value, set, min, max, step, fmt }) {
    const field = useContext(SettingsFieldContext);
    return (
      <div className="set-range">
        <input id={field?.controlId} aria-labelledby={field?.labelId} className="lw" type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(parseFloat(e.target.value))} />
        <span className="set-rv">{fmt(value)}</span>
      </div>
    );
  }
  const FieldInput = React.forwardRef(function FieldInput(props, ref) {
    const field = useContext(SettingsFieldContext);
    const named = props['aria-label'] || props['aria-labelledby'];
    const accessibility = !named && field
      ? { id: props.id || field.controlId, 'aria-labelledby': field.labelId }
      : {};
    return <input ref={ref} {...accessibility} {...props} />;
  });
  function FieldTextarea(props) {
    const field = useContext(SettingsFieldContext);
    const named = props['aria-label'] || props['aria-labelledby'];
    const accessibility = !named && field
      ? { id: props.id || field.controlId, 'aria-labelledby': field.labelId }
      : {};
    return <textarea {...accessibility} {...props} />;
  }

  // ── Live wiring helpers ───────────────────────────────────────────────
  // Mockup Seg labels stay verbatim; these map them to the real enum values.
  const THEME_LABELS = ['Studio', 'Daylight'];
  const THEME_VALUE = { Studio: 'studio', Daylight: 'daylight' };
  const THEME_LABEL = { studio: 'Studio', daylight: 'Daylight' };

  const SMOOTH_LABELS = ['Off', 'Soft', 'Smooth'];
  // real MOTION_SMOOTHING_MODES = ['off','soft','silk']; map by index, label stays mockup-native
  const SMOOTH_VALUE = { Off: MOTION_SMOOTHING_MODES[0], Soft: MOTION_SMOOTHING_MODES[1], Smooth: MOTION_SMOOTHING_MODES[2] };
  const SMOOTH_LABEL = { [MOTION_SMOOTHING_MODES[0]]: 'Off', [MOTION_SMOOTHING_MODES[1]]: 'Soft', [MOTION_SMOOTHING_MODES[2]]: 'Smooth' };

  const RES_LABELS = ['Low', 'Med', 'High'];
  const RES_VALUE = { Low: 0.75, Med: 1.0, High: 1.5 };
  const RES_LABEL = (dpr) => (dpr <= 0.75 ? 'Low' : dpr >= 1.5 ? 'High' : 'Med');

  const FPS_LABELS = ['15', '25', '30', '40'];

  const RUNTIME_LABELS = ['Playlist', 'Single', 'Sequence'];
  // real STANDALONE_RUNTIME_MODES = ['sequence','procedural','preset']
  const RUNTIME_VALUE = { Playlist: 'sequence', Single: 'procedural', Sequence: 'preset' };
  const RUNTIME_LABEL = { sequence: 'Playlist', procedural: 'Single', preset: 'Sequence' };

  const COLOR_ORDER_LABELS = ['RGB', 'GRB', 'BRG'];

  function formatSavedTime(lastSaved) {
    if (!lastSaved) return 'no recovery copy yet';
    return `recovery copy ${new Date(lastSaved).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  function formatLibraryTime(updatedAt) {
    if (!updatedAt) return 'not dated';
    return new Date(updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // ── Ring hardware summary (live RingSummary visual) ──────────────────
  function RingSummary({ sections, targets, activeLookLabel }) {
    const sectionRows = sections.slice(0, 5).map((section, index) => {
      const target = targets.find(item => item.id === section.id || item.label === section.name);
      const pattern = getCardPatternById(target?.look?.patternId);
      return {
        ...section,
        patternLabel: pattern?.label || target?.look?.patternId || activeLookLabel || 'Current look',
      };
    });
    const outer = sectionRows[0];
    const inner = sectionRows[1];
    return (
      <div className="set-ring" data-testid="settings-ring-summary">
        <div className="sec-h"><span className="t">Visual setup</span><span className="m">{sections.length} sections</span></div>
        <div className="set-ring-stage" aria-hidden="true">
          <span className="set-ring-orbit outer" />
          <span className="set-ring-orbit inner" />
          {sections.length > 2 && <span className="set-ring-orbit center">{sections.length}</span>}
        </div>
        <div className="set-ring-copy">
          {outer && (<div><strong>Outer circle</strong><span>{outer.pixels} LEDs · {outer.patternLabel}</span></div>)}
          {inner && (<div><strong>Inner circle</strong><span>{inner.pixels} LEDs · {inner.patternLabel}</span></div>)}
          {sectionRows.slice(2).map(section => (
            <div key={section.id}><strong>{section.name}</strong><span>{section.pixels} LEDs · {section.patternLabel}</span></div>
          ))}
        </div>
      </div>
    );
  }

  function SettingsScreen() {
    const {
      projectId,
      projectLifecycle,
      projectName, setProjectName,
      bpm, setBpm,
      showDuration, setShowDuration,
      palette, setPalette,
      masterSpeed, setMasterSpeed,
      masterBrightness, setMasterBrightness,
      masterSaturation, setMasterSaturation,
      masterHueShift, setMasterHueShift,
      motionSmoothing, setMotionSmoothing,
      gammaEnabled, setGammaEnabled,
      strips, setStrips,
      viewBox, setViewBox,
      svgText,
      patchBoard, setPatchBoard,
      standaloneController, setStandaloneController,
      serializeProject, replaceProject, replaceWithNewProject,
      markProjectPersisted, markProjectInstalled, markCardLookConfirmed,
      lastSaved,
    } = useProject();
    const { tweaks, set: setTweak } = useTweaks();
    useEffect(() => {
      document.documentElement.dataset.theme = tweaks.theme === 'daylight' ? 'daylight' : 'studio';
    }, [tweaks.theme]);

    const importRef = useRef(null);
    const [cardHost, setCardHost] = useState(readStoredCardHost);
    const [status, setStatus] = useState('');
    const [statusKind, setStatusKind] = useState('');
    const [cardWrite, dispatchCardWrite] = useReducer(cardActionReducer, undefined, createCardActionState);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [projectLibrary, setProjectLibrary] = useState(() => listProjectLibraryRecords());
    const [activeProjectRecordId, setActiveProjectRecordId] = useState(() => readActiveProjectLibraryRecordId());
    const liveHardwareSeq = useRef(0);

    // ── Derived card / hardware data (mirrors the old ChipScreen) ──────
    const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
    const zones = useMemo(() => patchBoardToZones(board, strips), [board, strips]);
    const runtimePackage = useMemo(
      () => buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: board, standaloneController }),
      [projectId, projectName, strips, board, standaloneController],
    );
    const config = runtimePackage.config;
    const configJson = useMemo(() => JSON.stringify(config, null, 2), [config]);
    const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

    const savedLooks = normalizeSavedLooks(standaloneController?.looks);
    const activeSavedLook = savedLooks.find(look => look.id === standaloneController?.activeLookId) || savedLooks[0] || null;
    const defaultLook = normalizeSectionVisualLook(standaloneController?.defaultLook);
    const sectionTargets = useMemo(
      () => deriveSectionTargets({ strips, patchBoard: board, defaultLook }),
      [strips, board, defaultLook.patternId, defaultLook.brightness, defaultLook.speed, defaultLook.hueShift,
       defaultLook.customHue, defaultLook.customSaturation, defaultLook.customBreathe, defaultLook.customDrift],
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

    const controllerOutputs = (config.led.outputs.length ? config.led.outputs : DEFAULT_STANDALONE_OUTPUTS).map((output, index) => ({
      ...(DEFAULT_STANDALONE_OUTPUTS[index] || {}),
      ...output,
    }));

    const encoder = standaloneController?.controls?.encoder || {};
    const encoderDir = encoder.rotateDirection === 'clockwise-dimmer' ? 'clockwise-dimmer' : 'clockwise-brighter';
    const encoderStep = Number.isFinite(+encoder.brightnessStep) ? +encoder.brightnessStep : 18;

    // ── Controller / hardware mutators (verbatim from ChipScreen) ──────
    const applyDefaultHardwareLayout = ({ totalPixels = null, sectionCount = null, sectionPixelCounts = null } = {}) => {
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
      setViewBox(viewBox || '0 0 640 400');
      setStrips(nextStrips);
      setPatchBoard(normalizePatchBoard(null, nextStrips));
      setStandaloneController(prev => {
        const current = prev || {};
        const outputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => {
          const previous = current.outputs?.[index] || {};
          return {
            ...base,
            ...previous,
            id: index === 0 ? 'out1' : base.id,
            name: index === 0 ? 'Output 1' : base.name,
            pixels: index === 0 ? nextTotal : 0,
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

    const routeAsSingleOutput = () => {
      setStandaloneController(prev => {
        const current = prev || {};
        const totalPixels = config.led.pixels || hardwareSections.reduce((sum, section) => sum + section.pixels, 0) || DEFAULT_CIRCLE_TOTAL_PIXELS;
        const previous = current.outputs?.[0] || {};
        const outputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => ({
          ...base,
          ...((current.outputs || [])[index] || {}),
          name: index === 0 ? (previous.name || 'Main chain') : base.name,
          pixels: index === 0 ? totalPixels : 0,
        }));
        return { ...current, outputs };
      });
    };

    const routeBySections = () => {
      setStandaloneController(prev => {
        const current = prev || {};
        const nextOutputs = DEFAULT_STANDALONE_OUTPUTS.map((base, index) => {
          const section = hardwareSections[index];
          const previous = current.outputs?.[index] || {};
          return {
            ...base,
            ...previous,
            name: section?.name || previous.name || base.name,
            pixels: section ? section.pixels : 0,
          };
        });
        return { ...current, outputs: nextOutputs };
      });
    };

    const persistHost = (value) => { setCardHost(value); writeStoredCardHost(value); };

    const loadMethod = cardLoadMethodForProtocol(typeof window !== 'undefined' ? window.location.protocol : 'https:');
    const directPushAvailable = loadMethod.directPush;

    const updateColorOrder = (value) => {
      const colorOrder = String(value || '').toUpperCase();
      updateController({ led: { colorOrder } });
      if (!directPushAvailable) {
        setStatusKind('');
        setStatus('Color order changed in Studio. Open the local Studio to preview this live on the card.');
        return;
      }
      const seq = ++liveHardwareSeq.current;
      setStatusKind('');
      setStatus(`Previewing ${colorOrder} color order on ${cardHostToUrl(cardHost)}...`);
      pushLiveHardwareToCard({ colorOrder }, { host: cardHost, timeoutMs: 2000 })
        .then(response => {
          if (seq !== liveHardwareSeq.current) return;
          setStatusKind('ok');
          setStatus(`Color order is live on the card: ${response.colorOrder || colorOrder}. Save to card to keep it after restart.`);
        })
        .catch(() => {
          if (seq !== liveHardwareSeq.current) return;
          setStatusKind('err');
          setStatus(`Color order changed in Studio, but ${cardHostToUrl(cardHost)} did not answer.`);
        });
    };

    const pushDirect = async () => {
      const requestedRevision = projectLifecycle.editedRevision;
      dispatchCardWrite({ type: 'start', revision: requestedRevision });
      setStatusKind('');
      setStatus(`Sending to ${cardHostToUrl(cardHost)}...`);
      try {
        const response = await pushConfigToCard(runtimePackage, { host: cardHost, timeoutMs: 6000, reboot: 'if-needed', allowLayoutChange: true });
        markProjectInstalled(requestedRevision);
        markCardLookConfirmed({ ...defaultLook, syncZones: true });
        dispatchCardWrite({ type: 'confirm' });
        setStatusKind('ok');
        setStatus(response.rebooting
          ? 'Saved on card. Rebooting now so the LED output layout takes effect.'
          : 'Saved on card.');
      } catch (error) {
        dispatchCardWrite({ type: 'fail', error: error?.message });
        setStatusKind('err');
        setStatus(error?.reason === 'project-mismatch' || error?.reason === 'config-too-large'
          ? error.message
          : 'Could not reach the card. Copy or download the card settings and paste them on the card page.');
      }
    };

    const openCardInstaller = () => {
      try {
        const url = buildCardConfigHandoffUrl(cardHost, runtimePackage);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (error) {
        setStatusKind('err');
        setStatus(error?.reason === 'config-too-large'
          ? error.message
          : 'Could not prepare the card installer. Try again.');
      }
    };

    const copyConfig = async () => {
      try {
        await navigator.clipboard.writeText(cardStorageJson(runtimePackage));
        setStatusKind('ok');
        setStatus('Card settings copied. Paste them into the card page on the same WiFi.');
      } catch (error) {
        setStatusKind('err');
        setStatus(error?.reason === 'config-too-large'
          ? error.message
          : 'Clipboard was blocked. Use Download card settings instead.');
      }
    };

    // ── Project file + library (verbatim from ChipScreen) ──────────────
    const saveProjectFile = async () => {
      const data = serializeProject();
      const ok = await downloadJsonFile(`${safeProjectName || 'lightweaver'}-studio-project.lwproj.json`, data);
      if (ok) markProjectPersisted('file');
      setStatusKind(ok ? 'ok' : 'err');
      setStatus(ok ? 'Project file download started.' : 'Could not start the project file download.');
    };

    const importProjectFile = (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          const result = await replaceProject(data);
          if (result.reason === 'invalid') {
            setStatusKind('err');
            setStatus('That project file does not look like a Lightweaver Studio project.');
            return;
          }
          if (!result.ok) return;
          writeActiveProjectLibraryRecordId('');
          setActiveProjectRecordId('');
          setStatusKind('ok');
          setStatus('Project opened in Studio.');
        } catch {
          setStatusKind('err');
          setStatus('Could not read that project file.');
        }
      };
      reader.readAsText(file);
      event.target.value = '';
    };

    const refreshProjectLibrary = () => {
      setProjectLibrary(listProjectLibraryRecords());
      setActiveProjectRecordId(readActiveProjectLibraryRecordId());
    };

    const saveProjectToLibrary = () => {
      try {
        const record = saveProjectLibraryRecord(createProjectLibraryRecord(serializeProject()));
        markProjectPersisted('browser');
        writeActiveProjectLibraryRecordId(record.id);
        setActiveProjectRecordId(record.id);
        refreshProjectLibrary();
        setStatusKind('ok');
        setStatus(`Saved ${record.name} in this browser.`);
      } catch (error) {
        setStatusKind('err');
        setStatus(error.message || 'Could not save this Studio project.');
      }
    };

    const updateProjectInLibrary = () => {
      if (!activeProjectRecordId) { saveProjectToLibrary(); return; }
      try {
        const record = saveProjectLibraryRecord(createProjectLibraryRecord(serializeProject(), { id: activeProjectRecordId }));
        markProjectPersisted('browser');
        writeActiveProjectLibraryRecordId(record.id);
        refreshProjectLibrary();
        setStatusKind('ok');
        setStatus(`Updated ${record.name} in this browser.`);
      } catch (error) {
        setStatusKind('err');
        setStatus(error.message || 'Could not update this Studio project.');
      }
    };

    const openProjectFromLibrary = async (record) => {
      if (!record) return;
      const result = await replaceProject(record.project);
      if (result.reason === 'invalid') {
        setStatusKind('err');
        setStatus('That saved project could not be opened.');
        return;
      }
      writeActiveProjectLibraryRecordId(record.id);
      setActiveProjectRecordId(record.id);
      setStatusKind('ok');
      setStatus(`Opened ${record.name}.`);
    };

    const duplicateProjectInLibrary = (record) => {
      if (!record) return;
      const copy = duplicateProjectLibraryRecord(record.id);
      if (!copy) {
        setStatusKind('err');
        setStatus('That saved project could not be duplicated.');
        return;
      }
      refreshProjectLibrary();
      setStatusKind('ok');
      setStatus(`Duplicated ${record.name}.`);
    };

    const deleteProjectFromLibrary = (record) => {
      if (!record) return;
      if (!window.confirm(`Delete ${record.name} from this browser?`)) return;
      deleteProjectLibraryRecord(record.id);
      if (activeProjectRecordId === record.id) {
        writeActiveProjectLibraryRecordId('');
        setActiveProjectRecordId('');
      }
      refreshProjectLibrary();
      setStatusKind('ok');
      setStatus(`Deleted ${record.name} from this browser.`);
    };

    const startNewProject = async () => {
      const result = await replaceWithNewProject();
      if (!result.ok) return;
      writeActiveProjectLibraryRecordId('');
      setActiveProjectRecordId('');
    };

    useEffect(() => {
      const onLibraryChange = () => refreshProjectLibrary();
      window.addEventListener?.(PROJECT_LIBRARY_CHANGED_EVENT, onLibraryChange);
      return () => window.removeEventListener?.(PROJECT_LIBRARY_CHANGED_EVENT, onLibraryChange);
    }, []);

    // ── Mockup-card live values ─────────────────────────────────────────
    const themeLabel = THEME_LABEL[tweaks.theme] || 'Studio';
    const smoothLabel = SMOOTH_LABEL[motionSmoothing] || 'Soft';
    const resLabel = RES_LABEL(tweaks.dpr || 1);
    const fpsLabel = FPS_LABELS.includes(String(tweaks.wledFps)) ? String(tweaks.wledFps) : '25';
    const runtimeLabel = RUNTIME_LABEL[standaloneController?.runtimeMode] || 'Playlist';
    const colorOrderLabel = COLOR_ORDER_LABELS.includes(config.led.colorOrder) ? config.led.colorOrder : 'RGB';
    const brightnessLimit255 = Math.round((config.led.brightnessLimit ?? 0.45) * 255);
    const addPaletteColor = () => {
      // pick the next wheel swatch not already in the palette, else the first
      const next = SWATCHES.find(s => !palette.includes(s)) || SWATCHES[palette.length % SWATCHES.length];
      setPalette([...palette, next]);
    };

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="set">
            <h1 className="set-title">Settings</h1>

            {/* ── Live-only: Card connection (top section, mockup idiom) ── */}
            <div className="set-cols set-cols-1">
              <div className="set-col">
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Card connection</span><span className="m">{directPushAvailable ? 'local card write' : 'copy or download'}</span></div>
                  <Row label="Card address" hint="The card's name on your WiFi">
                    <FieldInput className="pm-input" value={cardHost} onChange={(e) => persistHost(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="lightweaver.local" />
                  </Row>
                  <Row label="Write to card" hint="Save this setup onto the chip" stack>
                    <div className="set-actions">
                      {directPushAvailable && <button className="btn" onClick={pushDirect} disabled={cardWrite.conflictsDisabled}>{cardWrite.status === 'pending' ? 'Saving…' : cardWrite.status === 'failed' ? 'Retry save' : 'Save to card'}</button>}
                      {!directPushAvailable && <button className="btn" onClick={openCardInstaller}>{I.open}Open card installer</button>}
                      <button className="btn ghost-sm" onClick={copyConfig}>{I.copy}Copy settings</button>
                      <button className="btn ghost-sm" onClick={() => window.open(cardHostToUrl(cardHost) || CARD_PAGE_FALLBACK, '_blank')}>{I.open}Open card page</button>
                      <button className="btn ghost-sm" onClick={() => { window.location.hash = '#screen=flash'; }}>{I.bolt}Flash chip</button>
                      <button className="btn ghost-sm" onClick={() => { window.location.hash = '#screen=installer'; }}>{I.info}Installer guide</button>
                    </div>
                  </Row>
                  {status && (
                    <div className={`set-status${statusKind ? ` is-${statusKind}` : ''}`} data-testid="settings-card-status">{status}</div>
                  )}
                </section>
              </div>
            </div>

            <div className="set-cols">
              <div className="set-col">
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Project</span></div>
                  <Row label="Project name"><FieldInput className="pm-input" value={projectName} onChange={(e) => setProjectName(e.target.value)} /></Row>
                  <Row label="Default BPM" hint="Used for beat-quantized clip recording"><FieldInput className="num-input" type="number" value={bpm} onChange={(e) => setBpm(+e.target.value)} /></Row>
                  <Row label="Show duration" hint="Total timeline length"><div className="set-v-inline"><FieldInput className="num-input" type="number" value={showDuration} onChange={(e) => setShowDuration(+e.target.value)} /><span className="set-u">sec</span></div></Row>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Pattern palette</span><span className="m">read by all patterns</span></div>
                  <div className="set-pal">
                    {palette.map((s, i) => (
                      <span key={i} className="set-palsw" style={{ background: s }}>
                        <button className="set-palx" aria-label={`Remove palette color ${i + 1} ${s}`} onClick={() => setPalette(palette.filter((_, k) => k !== i))}>{I.x}</button>
                      </span>
                    ))}
                    <button className="set-paladd" aria-label="Add palette color" onClick={addPaletteColor}>{I.plus}</button>
                  </div>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Look defaults</span></div>
                  <Row label="Theme"><Seg opts={THEME_LABELS} val={themeLabel} set={(o) => setTweak('theme', THEME_VALUE[o])} /></Row>
                  <Row label="Master speed default"><Range value={masterSpeed} set={setMasterSpeed} min={0.1} max={3} step={0.01} fmt={(v) => `${v.toFixed(2)}×`} /></Row>
                  <Row label="Motion smoothing"><Seg opts={SMOOTH_LABELS} val={smoothLabel} set={(o) => setMotionSmoothing(SMOOTH_VALUE[o])} /></Row>
                  <Row label="Master brightness"><Range value={Math.round(masterBrightness * 100)} set={(v) => setMasterBrightness(v / 100)} min={5} max={100} step={1} fmt={(v) => `${v}%`} /></Row>
                  <Row label="Master saturation"><Range value={Math.round(masterSaturation * 100)} set={(v) => setMasterSaturation(v / 100)} min={0} max={100} step={1} fmt={(v) => `${v}%`} /></Row>
                  <Row label="Master hue shift" hint="Rotates all colors on the wheel">
                    <div className="set-v-inline"><Range value={Math.round(masterHueShift * 256)} set={(v) => setMasterHueShift(v / 256)} min={-128} max={128} step={1} fmt={(v) => `${v}`} /><button className="btn ghost-sm" onClick={() => setMasterHueShift(0)}>Reset</button></div>
                  </Row>
                </section>
              </div>

              <div className="set-col">
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Rendering</span></div>
                  <Row label="Gamma correction" hint="Corrects LED brightness curve"><button type="button" aria-label="Gamma correction" aria-pressed={gammaEnabled} className={"ex-toggle" + (gammaEnabled ? " on" : "")} onClick={() => setGammaEnabled(!gammaEnabled)} /></Row>
                  <Row label="Canvas resolution" hint="Lower = faster rendering"><Seg opts={RES_LABELS} val={resLabel} set={(o) => setTweak('dpr', RES_VALUE[o])} /></Row>
                  <Row label="Card push fps" hint="Max frames per second sent to the card"><Seg opts={FPS_LABELS} val={fpsLabel} set={(o) => setTweak('wledFps', +o)} /></Row>
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Card &amp; hardware</span></div>
                  <Row label="Runtime mode" hint="What the card plays from on boot"><Seg opts={RUNTIME_LABELS} val={runtimeLabel} set={(o) => updateController({ runtimeMode: RUNTIME_VALUE[o] })} /></Row>
                  <Row label="Color order" hint="This card is calibrated to RGB"><Seg opts={COLOR_ORDER_LABELS} val={colorOrderLabel} set={updateColorOrder} /></Row>
                  <Row label="Brightness limit" hint="Max firmware output for sellable pieces"><Range value={brightnessLimit255} set={(v) => updateController({ led: { brightnessLimit: Math.max(0.05, Math.min(1, v / 255)) } })} min={32} max={255} step={1} fmt={(v) => `${v}`} /></Row>
                  <Row label="LED output" hint="Firmware uses fixed connector pins" stack>
                    <div className="set-output">
                      <FieldInput aria-label="LED output name" className="pm-input" value={controllerOutputs[0]?.name || 'Output 1'} onChange={(e) => updateOutput(0, { name: e.target.value })} style={{ flex: 2 }} />
                      <div className="set-outfield"><FieldInput aria-label="LED output GPIO" className="num-input" type="number" min="0" max="48" value={controllerOutputs[0]?.pin ?? 16} onChange={(e) => updateOutput(0, { pin: +e.target.value })} style={{ width: 56 }} /><span>GPIO</span></div>
                      <div className="set-outfield"><FieldInput aria-label="LED output pixels" className="num-input" type="number" min="0" max="2048" value={controllerOutputs[0]?.pixels || 0} onChange={(e) => updateOutput(0, { pixels: +e.target.value })} style={{ width: 70 }} /><span>pixels</span></div>
                    </div>
                  </Row>
                  <RingSummary sections={hardwareSections} targets={sectionTargets} activeLookLabel={activeSavedLook?.label || 'Current look'} />
                </section>

                <section className="card set-card">
                  <div className="sec-h"><span className="t">Project file</span></div>
                  <Row label="Save project" hint="Download a .lwproj.json file you can reload"><button className="btn" onClick={saveProjectFile}>{I.download}Download .lwproj.json</button></Row>
                  <Row label="Load project" hint="Import a .lwproj.json file">
                    <button className="btn" onClick={() => importRef.current?.click()}>{I.doc}Choose file…</button>
                    <FieldInput ref={importRef} type="file" accept=".json,.lwproj.json,.lw.json" className="set-file-input" onChange={importProjectFile} />
                  </Row>
                </section>
              </div>
            </div>

            {/* ── Live-only extra cards (mockup idiom) ── */}
            <div className="set-cols">
              <div className="set-col">
                {/* Dial / encoder — relocated here from Patterns */}
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Dial / encoder</span><span className="m">physical knob</span></div>
                  <Row label="Rotate direction" hint="Which way turns the brightness up"><Seg opts={["CW brighter", "CW dimmer"]} val={encoderDir === 'clockwise-dimmer' ? 'CW dimmer' : 'CW brighter'} set={(o) => updateController({ controls: { encoder: { rotateDirection: o === 'CW dimmer' ? 'clockwise-dimmer' : 'clockwise-brighter' } } })} /></Row>
                  <Row label="Brightness step" hint="How much each click changes brightness"><Range value={encoderStep} set={(v) => updateController({ controls: { encoder: { brightnessStep: Math.max(1, Math.min(64, Math.round(v))) } } })} min={1} max={64} step={1} fmt={(v) => `${v}`} /></Row>
                </section>

                {/* Project library — browser-saved Studio projects */}
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Project library</span><span className="m">{formatSavedTime(lastSaved)}</span></div>
                  <Row label="Browser library" hint="Editable Studio projects in this browser" stack>
                    <div className="set-actions">
                      <button className="btn" onClick={saveProjectToLibrary}>Save current</button>
                      <button className="btn ghost-sm" onClick={updateProjectInLibrary} disabled={!activeProjectRecordId}>Update opened</button>
                      <button className="btn ghost-sm" onClick={startNewProject}>New</button>
                    </div>
                  </Row>
                  <div className="set-lib">
                    {projectLibrary.length ? projectLibrary.map(record => (
                      <div key={record.id} className={`set-lib-row${record.id === activeProjectRecordId ? ' is-active' : ''}`}>
                        <div className="set-lib-main">
                          <strong>{record.name}</strong>
                          <span>{formatLibraryTime(record.updatedAt)} · project v{record.projectVersion}</span>
                        </div>
                        <div className="set-lib-actions">
                          <button className="btn ghost-sm" onClick={() => openProjectFromLibrary(record)}>Open</button>
                          <button className="btn ghost-sm" onClick={() => duplicateProjectInLibrary(record)}>Duplicate</button>
                          <button className="btn ghost-sm" onClick={() => deleteProjectFromLibrary(record)}>Delete</button>
                        </div>
                      </div>
                    )) : (
                      <div className="set-lib-empty">No saved Studio projects in this browser yet.</div>
                    )}
                  </div>
                </section>
              </div>

              <div className="set-col">
                {/* Hardware layout editor — total LEDs, sections, routing */}
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Hardware layout</span><span className="m">{config.led.pixels} pixels · {hardwareSections.length || hardwareSectionCount} sections</span></div>
                  <Row label="Total LEDs" hint={editableDefaultLayout ? 'used by the default circles' : 'from the imported layout'}>
                    <FieldInput className="num-input" type="number" min="1" max="2048" value={config.led.pixels} disabled={!editableDefaultLayout} onChange={(e) => applyDefaultHardwareLayout({ totalPixels: e.target.value })} />
                  </Row>
                  <Row label="Sections" hint={editableDefaultLayout ? 'zones on the chip' : 'from strips and patches'}>
                    <FieldInput className="num-input" type="number" min="1" max={DEFAULT_CIRCLE_SECTION_LIMIT} value={hardwareSections.length || hardwareSectionCount} disabled={!editableDefaultLayout} onChange={(e) => applyDefaultHardwareLayout({ sectionCount: e.target.value })} />
                  </Row>
                  <Row label="Section LEDs" hint={editableDefaultLayout ? 'inner and outer counts' : 'read from layout'} stack>
                    <div className="set-seccounts">
                      {hardwareSections.map((section, index) => (
                        <label key={section.id} className="set-seccount">
                          <span>{section.name}</span>
                          <input className="num-input" type="number" min="1" max="2048" value={section.pixels} disabled={!editableDefaultLayout} onChange={(e) => updateDefaultSectionPixels(index, e.target.value)} />
                        </label>
                      ))}
                    </div>
                  </Row>
                  <Row label="Output routing" hint="GPIO and pixel count per output" stack>
                    <div className="set-outputs">
                      <div className="set-outputs-toolbar">
                        <div data-testid="output-routing-summary">
                          <strong>{controllerOutputs.length} {controllerOutputs.length === 1 ? 'output' : 'outputs'}</strong>
                          <span>{config.led.outputs.reduce((sum, output) => sum + output.pixels, 0)} LEDs routed</span>
                        </div>
                        <div className="set-actions">
                          <button className="btn ghost-sm" type="button" onClick={routeAsSingleOutput}>Single output</button>
                          <button className="btn ghost-sm" type="button" onClick={routeBySections}>Split by sections</button>
                        </div>
                      </div>
                      <div className="set-outputs-list">
                        {controllerOutputs.map((output, index) => (
                          <div key={output.id || index} className="set-output-row">
                            <FieldInput className="pm-input" value={output.name || `Output ${index + 1}`} onChange={(e) => updateOutput(index, { name: e.target.value })} aria-label={`Output ${index + 1} name`} />
                            <div className="set-outfield"><FieldInput aria-label={`Output ${index + 1} GPIO`} className="num-input" type="number" min="0" max="48" value={output.pin ?? 0} onChange={(e) => updateOutput(index, { pin: +e.target.value })} style={{ width: 56 }} /><span>GPIO</span></div>
                            <div className="set-outfield"><FieldInput aria-label={`Output ${index + 1} pixels`} className="num-input" type="number" min="0" max="2048" value={output.pixels || 0} onChange={(e) => updateOutput(index, { pixels: +e.target.value })} style={{ width: 70 }} /><span>pixels</span></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Row>
                </section>

                {/* Advanced — designer config JSON disclosure */}
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Advanced</span><span className="m">{(configJson.length / 1024).toFixed(1)} KB</span></div>
                  <Row label="Designer config" hint="The exact JSON written to the card">
                    <button className="btn ghost-sm" onClick={() => setAdvancedOpen(o => !o)}>{advancedOpen ? 'Hide' : 'Show'} JSON</button>
                  </Row>
                  {advancedOpen && (
                    <div className="set-advanced"><FieldTextarea aria-label="Designer config JSON" readOnly value={configJson} className="set-json" /></div>
                  )}
                </section>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

export { SettingsScreen };
