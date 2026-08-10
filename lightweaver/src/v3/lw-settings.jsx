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
import { useCloudLibrary } from '../state/CloudLibraryContext.jsx';
import { ProjectLibraryPanel } from '../components/projects/ProjectLibraryPanel.jsx';
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
import { prepareCardDeployment, waitForCardDeploymentVerification } from '../lib/cardDeployment.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import { DEFAULT_CIRCLE_SECTION_COUNT } from '../lib/defaultCircleLayout.js';
import {
  cardHostToUrl,
  cardLoadMethodForProtocol,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardConfigHandoffUrl, cardStorageJson, pushConfigToCard, readCardProjectEvidence, readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { prepareCardStoragePayload } from '../lib/cardStoragePayload.js';
import { pushLiveHardwareToCard } from '../lib/cardLiveControl.js';
import { downloadJsonFile } from '../lib/downloadFile.js';
import { writeActiveProjectLibraryRecordId } from '../lib/projectStorage.js';
import { cardActionReducer, createCardActionState } from '../lib/cardAction.js';
import { canonicalProjectFileName, PROJECT_IMPORT_ACCEPT } from '../lib/projectFiles.js';
import { openLocalCardPage } from '../lib/cardBridge.js';
import { getActiveCardTransportAuthority } from '../lib/cardTransport.js';
import { saveProjectToCardFromGesture } from '../lib/cardProjectSave.js';
import { createProjectEnvelope } from '../lib/projectRepository.js';
import { StripColorOrderCheck } from '../components/layout/wire/StripColorOrderCheck.jsx';

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

  function SettingsScreen({ embedded = false, mode = 'all', cardLink = {} } = {}) {
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
      strips,
      patchBoard,
      compiledWiring,
      standaloneController, setStandaloneController,
      serializeProject, replaceProject,
      markProjectPersisted, markProjectInstalled, markCardLookConfirmed,
      lastSaved,
      autosaveStatus,
      projectRepositorySource,
    } = useProject();
    const cloudLibrary = useCloudLibrary();
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
    const [projectCopySource, setProjectCopySource] = useState(projectRepositorySource?.label || 'This browser');
    const [cardProjectSave, setCardProjectSave] = useState({ status: 'idle', progress: '' });
    const cardProjectSaveAbortRef = useRef(null);
    const liveHardwareSeq = useRef(0);

    // ── Derived card / hardware data (mirrors the old ChipScreen) ──────
    const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
    const zones = useMemo(() => patchBoardToZones(board, strips), [board, strips]);
    const preparedDeployment = useMemo(
      () => prepareCardDeployment({
        projectId,
        projectName,
        projectRevision: projectLifecycle.editedRevision,
        strips,
        patchBoard: board,
        compiledWiring,
        standaloneController,
      }),
      [projectId, projectName, projectLifecycle.editedRevision, strips, board, compiledWiring, standaloneController],
    );
    const runtimePackage = preparedDeployment.runtimePackage;
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
    // Outputs that actually carry pixels — what the read-only summary lists.
    const routedOutputs = controllerOutputs.filter(output => (output.pixels || 0) > 0);

    const encoder = standaloneController?.controls?.encoder || {};
    const encoderDir = encoder.rotateDirection === 'clockwise-dimmer' ? 'clockwise-dimmer' : 'clockwise-brighter';
    const encoderStep = Number.isFinite(+encoder.brightnessStep) ? +encoder.brightnessStep : 18;

    // ── Controller mutators (card-specific calibration only) ───────────
    // Layout/Wire is the sole editor for sections, LED counts, and output
    // routing; Card settings only reads that result (see the read-only
    // summary below) and edits card-side calibration such as runtime mode,
    // color order, brightness limit, and the encoder.
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

    const persistHost = (value) => { setCardHost(value); writeStoredCardHost(value); };
    const openLayoutWire = () => { window.location.hash = '#screen=layout&mode=wire'; };
    // Setup owns every question this panel only reports on.
    const openSetupLadder = () => { window.location.hash = '#screen=card&section=setup'; };

    // Setup asks which colour order this card is wired in, and proves it by
    // painting three blocks on the strip. This is the other half of that: try
    // an order against the card RIGHT NOW and refuse to claim it worked until
    // the card reports the same order back. Keep both — asking and proving are
    // different jobs, and only the asking was duplicated.
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
        .then(async response => {
          if (response?.ok !== true || !Number.isSafeInteger(response?.stateRevision)) {
            throw new Error('The card did not return a card-owned hardware acknowledgement.');
          }
          const readback = await readCardStatusEnvelope({ host: cardHost, timeoutMs: 2000 });
          if (!response.cardId || readback?.cardId !== response.cardId || readback?.led?.colorOrder !== colorOrder) {
            throw new Error('The card hardware readback did not match the requested color order.');
          }
          if (seq !== liveHardwareSeq.current) return;
          setStatusKind('ok');
          setStatus(`Color order ${colorOrder} was acknowledged and read back from the exact card. Check the real red, green, blue, and white appearance; Studio has not marked that visual test passed. Save to card to keep it after restart.`);
        })
        .catch(() => {
          if (seq !== liveHardwareSeq.current) return;
          setStatusKind('err');
          setStatus(`Color order changed in Studio, but ${cardHostToUrl(cardHost)} did not answer.`);
        });
    };

    const loadMethod = cardLoadMethodForProtocol(typeof window !== 'undefined' ? window.location.protocol : 'https:');
    const directPushAvailable = loadMethod.directPush;

    const pushDirect = async () => {
      const requestedRevision = projectLifecycle.editedRevision;
      const requestedGeneration = projectLifecycle.generation;
      dispatchCardWrite({ type: 'start', revision: requestedRevision });
      setStatusKind('');
      setStatus(`Sending to ${cardHostToUrl(cardHost)}...`);
      try {
        prepareCardStoragePayload(runtimePackage);
        const before = await readCardProjectEvidence({ host: cardHost });
        const response = await pushConfigToCard(runtimePackage, {
          host: cardHost,
          timeoutMs: 6000,
          reboot: 'if-needed',
          allowLayoutChange: true,
          factoryBlank: cardLink.cardBlank === true,
        });
        if (response?.state === 'staged') {
          throw new Error('The card kept this hardware change staged. Open Test & Install and confirm it on the real LEDs before it can be installed.');
        }
        setStatus('Verifying the exact project on the card…');
        const exactPrepared = { ...preparedDeployment, cardId: before.cardId };
        const verification = await waitForCardDeploymentVerification(exactPrepared, {
          readEvidence: () => readCardProjectEvidence({ host: cardHost }),
        });
        markProjectInstalled({
          revision: requestedRevision,
          generation: requestedGeneration,
          cardId: verification.cardId,
          projectRevision: exactPrepared.config.projectRevision,
          projectFingerprint: exactPrepared.config.projectFingerprint,
        });
        markCardLookConfirmed({ ...defaultLook, syncZones: true });
        dispatchCardWrite({ type: 'confirm' });
        setStatusKind('ok');
        setStatus(response.rebooting
          ? 'Installed on card. Rebooting now so the LED output layout takes effect.'
          : 'Installed on card.');
      } catch (error) {
        dispatchCardWrite({ type: 'fail', error: error?.message });
        setStatusKind('err');
        setStatus(error?.message
          || 'Could not reach the card. Copy or download the card settings and paste them on the card page.');
      }
    };

    const openCardInstaller = () => {
      try {
        const url = new URL(buildCardConfigHandoffUrl(cardHost, runtimePackage));
        const result = openLocalCardPage(cardHost, { path: `${url.pathname}${url.search}${url.hash}`, reason: 'card-installer' });
        if (!result.ok && result.reason === 'popup-blocked') {
          setStatusKind('err');
          setStatus('The browser blocked the card window. Allow popups for Studio, then try again.');
        }
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

    // ── Portable project files (online library is mounted below) ───────
    const saveProjectFile = async () => {
      const data = serializeProject();
      const ok = await downloadJsonFile(canonicalProjectFileName(projectName), data);
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
          cloudLibrary.detachProject();
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

    const saveProjectToCard = async () => {
      const authority = getActiveCardTransportAuthority(cardHost);
      if (!authority) {
        setStatusKind('err');
        setStatus('Connect this exact card before saving an editable project copy.');
        return;
      }
      const confirmed = window.confirm(
        'Touch a physical control on the Lightweaver card now. Then choose Continue to request a short-lived save permission from that exact card.',
      );
      if (!confirmed) return;

      const expectedHead = cardLink?.readiness?.projectHead || null;
      const envelope = createProjectEnvelope(serializeProject(), {
        parentHash: expectedHead,
        localRevision: Math.max(1, Number(projectLifecycle.editedRevision || 0) + 1),
        source: { kind: 'browser' },
      });
      const controller = new AbortController();
      cardProjectSaveAbortRef.current = controller;
      setCardProjectSave({ status: 'pending', progress: 'pairing' });
      setStatusKind('');
      setStatus('Waiting for the card to confirm the physical pairing gesture…');

      const result = await saveProjectToCardFromGesture({
        authority,
        envelope,
        expectedHead,
        commissioningProof: 'owner-confirmed-physical-control',
        signal: controller.signal,
        onProgress: progress => {
          setCardProjectSave({ status: 'pending', progress });
          if (progress === 'uploading') setStatus('Saving the complete editable project to the card…');
          if (progress === 'verifying') setStatus('Reading the project back from the card to verify it…');
        },
      });
      cardProjectSaveAbortRef.current = null;

      if (result.ok) {
        const sourceLabel = result.source?.label || `Lightweaver ${authority.cardId || 'card'}`;
        setProjectCopySource(sourceLabel);
        markProjectPersisted('card', { cardId: authority.cardId, contentHash: result.envelope?.contentHash });
        setCardProjectSave({ status: 'complete', progress: 'complete' });
        setStatusKind('ok');
        setStatus(`Editable project saved and verified. Open copy: ${sourceLabel}. Installed configuration remains separate.`);
        return;
      }

      setCardProjectSave({ status: result.reason, progress: '' });
      setStatusKind(result.reason === 'cancelled' ? '' : 'err');
      if (result.reason === 'pairing-required') {
        setStatus('Pairing required. Touch a physical control on the card, then choose Save project to this card again.');
      } else if (result.reason === 'head-conflict') {
        setStatus('The project on the card changed. Nothing was overwritten. Compare or export first, keep both copies, or deliberately replace after reopening the current card copy.');
      } else if (result.reason === 'quota-exceeded') {
        setStatus('The card does not have enough space for this editable project. Remove another card project or Export project to keep this copy.');
      } else if (result.reason === 'cancelled') {
        setStatus('Card project save cancelled.');
      } else if (result.reason === 'disconnected') {
        setStatus('The verified card connection ended before saving. Connect this exact card and try again.');
      } else {
        setStatus('The editable project was not saved to the card. The browser recovery copy is unchanged.');
      }
    };

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
    const showPreferences = mode === 'all' || mode === 'preferences';
    const showCard = mode === 'all' || mode === 'card';
    const showAdvanced = mode === 'all' || mode === 'advanced';
    const openColorOrderTest = showCard && typeof window !== 'undefined'
      && new URLSearchParams(window.location.hash.slice(1)).get('tool') === 'color-order';

    const content = (
          <div className={`set${embedded ? ' set-embedded' : ''}`}>
            {!embedded && <h1 className="set-title">Settings</h1>}

            {/* ── Live-only: Card connection (top section, mockup idiom) ── */}
            {showCard && <div className="set-cols set-cols-1">
              <div className="set-col">
                <section className="card set-card">
                  <div className="sec-h"><span className="t">Card connection</span><span className="m">{directPushAvailable ? 'local card write' : 'copy or download'}</span></div>
                  {/* Setup gets the card onto the WiFi. This is where Studio
                      LOOKS for it afterwards — the escape hatch when the name
                      will not resolve and only a raw IP will do, which is the
                      recovery path in card-workspace's "reachable recovering
                      factory card uses URL IP". Same words, different jobs, so
                      the hint says which job this one is. */}
                  <Row label="Card address" hint="The card's name on your WiFi — where Studio looks for it">
                    <div data-testid="card-address-summary">
                      <FieldInput className="pm-input" value={cardHost} onChange={(e) => persistHost(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="lightweaver.local" />
                    </div>
                  </Row>
                  {/* Setup installs a piece for the first time. The same verb
                      earns its place here because this is also the recovery
                      surface — see card-workspace's "reachable recovering
                      factory card uses URL IP", which reaches a card by raw IP
                      and installs from this page. The hint is what stops the
                      two reading as two setups. */}
                  <Row label="Install on card" hint="Sends what this page changed. First-time setup lives in Setup." stack>
                    <div className="set-actions">
                      {directPushAvailable && <button className="btn" onClick={pushDirect} disabled={cardWrite.conflictsDisabled}>{cardWrite.status === 'pending' ? 'Sending…' : cardWrite.status === 'failed' ? 'Retry install' : 'Install on card'}</button>}
                      {!directPushAvailable && <button className="btn" onClick={openCardInstaller}>{I.open}Open card installer</button>}
                      <button className="btn ghost-sm" onClick={copyConfig}>{I.copy}Copy settings</button>
                      <button className="btn ghost-sm" onClick={() => { const result = openLocalCardPage(cardHost); if (!result.ok && result.reason === 'popup-blocked') { setStatusKind('err'); setStatus('The browser blocked the card window. Allow popups for Studio, then try again.'); } }}>{I.open}Open card page</button>
                      <button className="btn ghost-sm" onClick={() => { window.location.hash = '#screen=card&section=install'; }}>{I.bolt}Flash chip</button>
                      <button className="btn ghost-sm" onClick={() => { window.location.hash = '#screen=card&section=support'; }}>{I.info}Installer guide</button>
                    </div>
                  </Row>
                  <Row label="Editable project" hint="A full project copy; separate from the installed configuration" stack>
                    <div>
                      <div className="set-actions">
                        <button
                          className="btn"
                          type="button"
                          onClick={saveProjectToCard}
                          disabled={cardProjectSave.status === 'pending'}
                          data-testid="save-project-to-card"
                        >
                          {cardProjectSave.status === 'pending' ? 'Saving project…' : 'Save project to this card'}
                        </button>
                        {cardProjectSave.status === 'pending' && (
                          <button className="btn ghost-sm" type="button" onClick={() => cardProjectSaveAbortRef.current?.abort()}>Cancel</button>
                        )}
                      </div>
                      <p className="hh">When prompted, touch a physical control on the card. The card must confirm that gesture before Studio can save.</p>
                      <p className="hh">Open copy: <strong>{projectCopySource}</strong>{cardProjectSave.progress ? ` · ${cardProjectSave.progress}` : ''}</p>
                    </div>
                  </Row>
                  {status && (
                    <div className={`set-status${statusKind ? ` is-${statusKind}` : ''}`} data-testid="settings-card-status">{status}</div>
                  )}
                </section>
              </div>
            </div>}

            <div className="set-cols">
              <div className="set-col">
                {showPreferences && <section className="card set-card">
                  <div className="sec-h"><span className="t">Project</span></div>
                  <Row label="Project name"><FieldInput className="pm-input" value={projectName} onChange={(e) => setProjectName(e.target.value)} /></Row>
                  <Row label="Default BPM" hint="Used for beat-quantized clip recording"><FieldInput className="num-input" type="number" value={bpm} onChange={(e) => setBpm(+e.target.value)} /></Row>
                  <Row label="Show duration" hint="Total timeline length"><div className="set-v-inline"><FieldInput className="num-input" type="number" value={showDuration} onChange={(e) => setShowDuration(+e.target.value)} /><span className="set-u">sec</span></div></Row>
                </section>}

                {showPreferences && <section className="card set-card">
                  <div className="sec-h"><span className="t">Pattern palette</span><span className="m">read by all patterns</span></div>
                  <div className="set-pal">
                    {palette.map((s, i) => (
                      <span key={i} className="set-palsw" style={{ background: s }}>
                        <button className="set-palx" aria-label={`Remove palette color ${i + 1} ${s}`} onClick={() => setPalette(palette.filter((_, k) => k !== i))}>{I.x}</button>
                      </span>
                    ))}
                    <button className="set-paladd" aria-label="Add palette color" onClick={addPaletteColor}>{I.plus}</button>
                  </div>
                </section>}

                {showPreferences && <section className="card set-card">
                  <div className="sec-h"><span className="t">Look defaults</span></div>
                  <Row label="Theme"><Seg opts={THEME_LABELS} val={themeLabel} set={(o) => setTweak('theme', THEME_VALUE[o])} /></Row>
                  <Row label="Master speed default"><Range value={masterSpeed} set={setMasterSpeed} min={0.1} max={3} step={0.01} fmt={(v) => `${v.toFixed(2)}×`} /></Row>
                  <Row label="Motion smoothing"><Seg opts={SMOOTH_LABELS} val={smoothLabel} set={(o) => setMotionSmoothing(SMOOTH_VALUE[o])} /></Row>
                  <Row label="Master brightness"><Range value={Math.round(masterBrightness * 100)} set={(v) => setMasterBrightness(v / 100)} min={5} max={100} step={1} fmt={(v) => `${v}%`} /></Row>
                  <Row label="Master saturation"><Range value={Math.round(masterSaturation * 100)} set={(v) => setMasterSaturation(v / 100)} min={0} max={100} step={1} fmt={(v) => `${v}%`} /></Row>
                  <Row label="Master hue shift" hint="Rotates all colors on the wheel">
                    <div className="set-v-inline"><Range value={Math.round(masterHueShift * 256)} set={(v) => setMasterHueShift(v / 256)} min={-128} max={128} step={1} fmt={(v) => `${v}`} /><button className="btn ghost-sm" onClick={() => setMasterHueShift(0)}>Reset</button></div>
                  </Row>
                </section>}
              </div>

              <div className="set-col">
                {showPreferences && <section className="card set-card">
                  <div className="sec-h"><span className="t">Rendering</span></div>
                  <Row label="Gamma correction" hint="Corrects LED brightness curve"><button type="button" aria-label="Gamma correction" aria-pressed={gammaEnabled} className={"ex-toggle" + (gammaEnabled ? " on" : "")} onClick={() => setGammaEnabled(!gammaEnabled)} /></Row>
                  <Row label="Canvas resolution" hint="Lower = faster rendering"><Seg opts={RES_LABELS} val={resLabel} set={(o) => setTweak('dpr', RES_VALUE[o])} /></Row>
                  <Row label="Card push fps" hint="Max frames per second sent to the card"><Seg opts={FPS_LABELS} val={fpsLabel} set={(o) => setTweak('wledFps', +o)} /></Row>
                </section>}

                {showCard && <section className="card set-card">
                  <div className="sec-h"><span className="t">Card &amp; hardware</span></div>
                  <Row label="Runtime mode" hint="What the card plays from on boot"><Seg opts={RUNTIME_LABELS} val={runtimeLabel} set={(o) => updateController({ runtimeMode: RUNTIME_VALUE[o] })} /></Row>
                  <Row label="Color order" hint="Setup asks this. Change it here to try an order on the strip right now.">
                    <div data-testid="color-order-summary"><Seg opts={COLOR_ORDER_LABELS} val={colorOrderLabel} set={updateColorOrder} /></div>
                  </Row>
                  <StripColorOrderCheck
                    cardHost={cardHost}
                    controller={standaloneController}
                    setController={setStandaloneController}
                    autoStart={openColorOrderTest}
                  />
                  <Row label="Brightness limit" hint="Max firmware output for sellable pieces"><Range value={brightnessLimit255} set={(v) => updateController({ led: { brightnessLimit: Math.max(0.05, Math.min(1, v / 255)) } })} min={32} max={255} step={1} fmt={(v) => `${v}`} /></Row>
                  <Row label="Layout & outputs" hint="Read-only — Layout owns structure and routing" stack>
                    <div className="set-outputs">
                      <div className="set-outputs-toolbar">
                        <div data-testid="output-routing-summary">
                          <strong>{config.led.pixels} LEDs · {hardwareSections.length || hardwareSectionCount} sections</strong>
                          <span>{routedOutputs.length || 1} {routedOutputs.length === 1 ? 'output' : 'outputs'} · {config.led.outputs.reduce((sum, output) => sum + (output.pixels || 0), 0)} LEDs routed</span>
                        </div>
                        <div className="set-actions">
                          <button className="btn" type="button" onClick={openLayoutWire}>Edit in Layout</button>
                        </div>
                      </div>
                      <div className="set-outputs-list">
                        {routedOutputs.map((output, index) => (
                          <div key={output.id || index} className="set-output-row" data-testid="output-summary-row">
                            <span className="pm-input set-output-ro">{output.name || `Output ${index + 1}`}</span>
                            <span className="set-outfield"><span className="num-input set-output-ro">{output.pin ?? 0}</span><span>GPIO</span></span>
                            <span className="set-outfield"><span className="num-input set-output-ro">{output.pixels || 0}</span><span>pixels</span></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Row>
                  <RingSummary sections={hardwareSections} targets={sectionTargets} activeLookLabel={activeSavedLook?.label || 'Current look'} />
                </section>}

              </div>
            </div>

            {/* ── Live-only extra cards (mockup idiom) ── */}
            <div className="set-cols">
              <div className="set-col">
                {/* Dial / encoder — relocated here from Patterns */}
                {showCard && <section className="card set-card">
                  <div className="sec-h"><span className="t">Dial / encoder</span><span className="m">physical knob</span></div>
                  <Row label="Rotate direction" hint="Which way turns the brightness up"><Seg opts={["CW brighter", "CW dimmer"]} val={encoderDir === 'clockwise-dimmer' ? 'CW dimmer' : 'CW brighter'} set={(o) => updateController({ controls: { encoder: { rotateDirection: o === 'CW dimmer' ? 'clockwise-dimmer' : 'clockwise-brighter' } } })} /></Row>
                  <Row label="Brightness step" hint="How much each click changes brightness"><Range value={encoderStep} set={(v) => updateController({ controls: { encoder: { brightnessStep: Math.max(1, Math.min(64, Math.round(v))) } } })} min={1} max={64} step={1} fmt={(v) => `${v}`} /></Row>
                </section>}

                {/* Projects — ONE consolidated persistence area: recovery-copy
                    status, browser library, import, and export. Autosave is the
                    automatic recovery copy, never the user's intentional save. */}
                {showPreferences && <section className="card set-card" data-testid="projects-area">
                  <div className="sec-h"><span className="t">Projects</span><span className="m">{formatSavedTime(lastSaved)}</span></div>
                  <Row label="Recovery copy" hint="Automatic backup Studio keeps while you work — not your saved project" stack>
                    <div className="set-recovery" data-testid="autosave-status">
                      <span>{formatSavedTime(lastSaved)}{autosaveStatus?.restoredFrom ? ` · restored from ${autosaveStatus.restoredFrom === 'legacy' ? 'an older Studio save' : 'the recovery copy'} this session` : ''}</span>
                      {autosaveStatus?.quarantine && (
                        <span className="set-recovery-warn" data-testid="autosave-quarantine">
                          A saved copy from a newer or damaged Studio session could not be opened. It was preserved untouched so support can recover it.
                          <button type="button" className="btn ghost-sm" onClick={() => autosaveStatus.dismissQuarantine()}>Dismiss</button>
                        </span>
                      )}
                    </div>
                  </Row>
                  <Row label="Project file" hint={`Portable ${'.lw.json'} file — export to keep or share, import to open`}>
                    <button className="btn" onClick={saveProjectFile}>{I.download}Export project</button>
                    <button className="btn" onClick={() => importRef.current?.click()}>{I.doc}Import project</button>
                    <FieldInput ref={importRef} type="file" accept={PROJECT_IMPORT_ACCEPT} className="set-file-input" onChange={importProjectFile} />
                  </Row>
                  <ProjectLibraryPanel />
                </section>}
              </div>

              <div className="set-col">
                {/* Advanced — designer config JSON disclosure */}
                {showAdvanced && <section className="card set-card">
                  <div className="sec-h"><span className="t">Advanced</span><span className="m">{(configJson.length / 1024).toFixed(1)} KB</span></div>
                  <Row label="Designer config" hint="The exact JSON written to the card">
                    <button className="btn ghost-sm" onClick={() => setAdvancedOpen(o => !o)}>{advancedOpen ? 'Hide' : 'Show'} JSON</button>
                  </Row>
                  {advancedOpen && (
                    <div className="set-advanced"><FieldTextarea aria-label="Designer config JSON" readOnly value={configJson} className="set-json" /></div>
                  )}
                </section>}
              </div>
            </div>
          </div>
    );
    return embedded ? content : <div className="screen"><div className="screen-scroll">{content}</div></div>;
  }

export { SettingsScreen };
