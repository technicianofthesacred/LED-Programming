import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { DEFAULT_CARD_CONTROLS, DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import {
  cardHueToDegrees,
  cardSaturationToChroma,
} from '../lib/cardVisualLook.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import {
  ALL_SECTIONS_TARGET_ID,
  applyLookToPatchBoard,
  applySavedLookToPatchBoard,
  deriveSectionTargets,
  normalizeSavedLooks,
  normalizeSectionVisualLook,
  saveCurrentLookToController,
  targetLabel,
} from '../lib/sectionLookModel.js';
import {
  cardHostToUrl,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { pushConfigToCard } from '../lib/cardPushClient.js';
import { pushLivePreviewToCard } from '../lib/cardLiveControl.js';
import { LEDPreview } from './Preview.jsx';

const SWATCHES = [8, 22, 36, 54, 78, 112, 145, 172, 198, 222, 238, 252];
const PATTERN_CATEGORIES = [
  { id: 'all', label: 'All', ids: null },
  { id: 'calm', label: 'Calm', ids: ['aurora', 'breathe', 'calm', 'drift', 'bloom', 'warm-white'] },
  { id: 'water', label: 'Water', ids: ['ocean', 'ripple', 'wave', 'plasma'] },
  { id: 'warm', label: 'Warm', ids: ['fire', 'lava', 'candle', 'ember', 'sunset', 'warm-white'] },
  { id: 'spark', label: 'Spark', ids: ['sparkle', 'twinkle', 'meteor', 'confetti', 'lightning'] },
  { id: 'motion', label: 'Motion', ids: ['chase', 'scanner', 'warp', 'pulse-ring', 'blocks', 'rainbow'] },
  { id: 'electric', label: 'Electric', ids: ['neon', 'matrix', 'heartbeat', 'stained'] },
];

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
    && a.speed === b.speed
    && a.hueShift === b.hueShift
    && a.customHue === b.customHue
    && a.customSaturation === b.customSaturation
    && a.customBreathe === b.customBreathe
    && a.customDrift === b.customDrift;
}

function patternLabel(patternId) {
  return getCardPatternById(patternId)?.label || String(patternId || 'Pattern');
}

function titleFromId(value = '') {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function comboLabelFromTargets(targets = [], defaultLook = {}) {
  const sections = (targets || []).filter(target => target?.kind === 'section');
  if (sections.length) {
    return sections
      .map(target => `${targetLabel(target)} ${patternLabel(target.look?.patternId)}`)
      .join(' + ');
  }
  return `${patternLabel(defaultLook.patternId)} whole piece`;
}

function patternMatchesCategory(pattern, categoryId) {
  const category = PATTERN_CATEGORIES.find(item => item.id === categoryId) || PATTERN_CATEGORIES[0];
  return !category.ids || category.ids.includes(pattern.id);
}

function LookCard({ pattern, look, previewing, saved, inCycle, onSelect, onCycleChange }) {
  const summary = previewing
    ? saved ? 'Previewing and saved here' : 'Previewing on LEDs'
    : saved ? 'Saved for this target' : pattern.description || 'Tap to preview this look';
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

function TargetButton({ target, active, onSelect }) {
  const pattern = getCardPatternById(target.look?.patternId);
  return (
    <button
      type="button"
      className={`lw-section-target ${active ? 'is-active' : ''}`}
      onClick={onSelect}
      data-testid={`section-target-${target.id}`}
    >
      <span>
        <strong>{target.label}</strong>
        <em>{target.kind === 'all' ? 'whole piece' : `${target.pixelCount} LEDs`}</em>
      </span>
      <b>{pattern?.label || target.look?.patternId || 'Pattern'}</b>
    </button>
  );
}

function SavedLookCard({ look, active, onApply, targets = [] }) {
  const targetById = new Map(targets.map(target => [target.id, target]));
  const sectionSummaries = Object.entries(look.sectionLooks || {}).map(([targetId, sectionLook]) => ({
    id: targetId,
    label: targetById.get(targetId)?.label || titleFromId(targetId),
    look: normalizeSectionVisualLook(sectionLook),
  }));
  const sectionCount = sectionSummaries.length;
  return (
    <button type="button" className={`lw-saved-look-card ${active ? 'is-active' : ''}`} onClick={onApply}>
      <span className="lw-saved-combo-previews" aria-hidden="true">
        {(sectionSummaries.length ? sectionSummaries : [{ id: 'all', label: 'All', look: look.defaultLook }]).slice(0, 3).map(section => (
          <LookPreview key={section.id} patternId={section.look?.patternId} look={section.look}/>
        ))}
      </span>
      <span className="lw-saved-combo-copy">
        <strong>{look.label}</strong>
        <em>{sectionCount || 1} section{sectionCount === 1 ? '' : 's'}</em>
        {sectionSummaries.length > 0 && (
          <span className="lw-saved-combo-sections">
            {sectionSummaries.map(section => `${section.label}: ${patternLabel(section.look.patternId)}`).join(' · ')}
          </span>
        )}
      </span>
    </button>
  );
}

export function PatternsScreen() {
  const {
    projectName,
    strips,
    viewBox,
    svgText,
    patchBoard,
    setPatchBoard,
    standaloneController,
    setStandaloneController,
  } = useProject();
  const [cardHost, setCardHost] = useState(readStoredCardHost);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [selectedTargetId, setSelectedTargetId] = useState(ALL_SECTIONS_TARGET_ID);
  const [draftLooks, setDraftLooks] = useState({});
  const [lookLabel, setLookLabel] = useState('');
  const [patternSearch, setPatternSearch] = useState('');
  const [patternCategory, setPatternCategory] = useState('all');
  const livePreviewTimer = useRef(null);
  const livePreviewSeq = useRef(0);
  const savedComboSeq = useRef(0);

  const savedGlobalLook = normalizeSectionVisualLook(standaloneController?.defaultLook);
  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const activeLookId = standaloneController?.activeLookId || '';
  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const sectionTargets = useMemo(
    () => deriveSectionTargets({ strips, patchBoard: board, defaultLook: savedGlobalLook }),
    [
      strips,
      board,
      savedGlobalLook.patternId,
      savedGlobalLook.brightness,
      savedGlobalLook.speed,
      savedGlobalLook.hueShift,
      savedGlobalLook.customHue,
      savedGlobalLook.customSaturation,
      savedGlobalLook.customBreathe,
      savedGlobalLook.customDrift,
    ],
  );
  const selectedTarget = sectionTargets.find(target => target.id === selectedTargetId) || sectionTargets[0];
  const savedTargetLook = normalizeSectionVisualLook(selectedTarget?.look || savedGlobalLook);
  const draftDefaultLook = normalizeSectionVisualLook(draftLooks[ALL_SECTIONS_TARGET_ID] || savedGlobalLook);
  const resolveDraftTargetLook = useCallback((target) => {
    if (!target) return draftDefaultLook;
    const targetDraft = draftLooks[target.id];
    if (targetDraft) return normalizeSectionVisualLook(targetDraft);
    if (target.kind === 'section' && draftLooks[ALL_SECTIONS_TARGET_ID]) return draftDefaultLook;
    return normalizeSectionVisualLook(target.look || draftDefaultLook);
  }, [draftDefaultLook, draftLooks]);
  const look = normalizeSectionVisualLook(
    draftLooks[selectedTarget?.id] ||
    (selectedTarget?.kind === 'section' && draftLooks[ALL_SECTIONS_TARGET_ID] ? draftDefaultLook : savedTargetLook),
  );
  const effectiveSectionTargets = useMemo(
    () => sectionTargets.map(target => ({ ...target, look: resolveDraftTargetLook(target) })),
    [resolveDraftTargetLook, sectionTargets],
  );
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
  const savedPattern = getCardPatternById(savedGlobalLook.patternId) || DEFAULT_CARD_PATTERN_BANK[0];
  const hasUnsavedPreview = !looksMatch(look, savedTargetLook);
  const selectedTargetName = selectedTarget ? targetLabel(selectedTarget) : 'All sections';
  const currentComboLabel = comboLabelFromTargets(effectiveSectionTargets, draftDefaultLook);
  const filteredPatterns = useMemo(() => {
    const query = patternSearch.trim().toLowerCase();
    return DEFAULT_CARD_PATTERN_BANK.filter(pattern => {
      if (!patternMatchesCategory(pattern, patternCategory)) return false;
      if (!query) return true;
      const searchable = `${pattern.label} ${pattern.description || ''} ${pattern.id}`.toLowerCase();
      return searchable.includes(query);
    });
  }, [patternCategory, patternSearch]);

  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectName, strips, patchBoard: board, standaloneController }),
    [projectName, strips, board, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const config = runtimePackage.config;
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const previewStrips = useMemo(() => {
    return (strips || []).map(strip => {
      const stripTarget = effectiveSectionTargets.find(target => target.kind === 'section' && target.stripId === strip.id);
      const targetLook = selectedTarget?.kind === 'all'
        ? look
        : selectedTarget?.stripId === strip.id
          ? look
          : normalizeSectionVisualLook(stripTarget?.look || draftDefaultLook);
      return {
        ...strip,
        patternId: targetLook.patternId,
        brightness: targetLook.brightness,
        speed: targetLook.speed,
        hueShift: targetLook.hueShift,
      };
    });
  }, [draftDefaultLook, effectiveSectionTargets, look, selectedTarget, strips]);

  useEffect(() => {
    if (sectionTargets.some(target => target.id === selectedTargetId)) return;
    setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
  }, [sectionTargets, selectedTargetId]);

  const updateController = (patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      return {
        ...current,
        ...patch,
        defaultLook: patch.defaultLook
          ? normalizeSectionVisualLook({ ...(current.defaultLook || {}), ...patch.defaultLook })
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

  const scheduleLivePreview = useCallback((nextLook, target = selectedTarget) => {
    if (!livePreviewEnabled) return;
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const zone = target?.kind === 'section' ? target.zoneId || target.id : '';
    livePreviewTimer.current = setTimeout(async () => {
      setStatusKind('');
      setStatus(`Previewing ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} on ${targetLabel(target)} at ${cardHostToUrl(cardHost)}...`);
      try {
        const response = await pushLivePreviewToCard(
          { ...nextLook, zone },
          { host: cardHost, timeoutMs: 2200, fallbackMissingZoneToAll: true },
        );
        if (sequence === livePreviewSeq.current) {
          setStatusKind('ok');
          const patternLabel = getCardPatternById(nextLook.patternId)?.label || nextLook.patternId;
          setStatus(response?.previewZoneFallback
            ? `Previewing ${patternLabel} on the whole card. Load this config onto the card once to preview ${targetLabel(target)} separately.`
            : `Previewing ${patternLabel} on ${targetLabel(target)}. Not saved yet.`);
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
  }, [cardHost, livePreviewEnabled, selectedTarget]);

  useEffect(() => () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
  }, []);

  const updatePreviewLook = (patch, { push = true } = {}) => {
    if (!selectedTarget) return;
    const nextLook = normalizeSectionVisualLook({ ...look, ...patch });
    setDraftLooks(prev => ({ ...prev, [selectedTarget.id]: nextLook }));
    if (push) scheduleLivePreview(nextLook, selectedTarget);
  };

  const buildCurrentHardwareState = ({ saveNamedLook = false, label = '', uniqueLookId = false } = {}) => {
    const nextLook = normalizeSectionVisualLook(look);
    const draftLookEntries = {
      ...draftLooks,
      [selectedTarget?.id || ALL_SECTIONS_TARGET_ID]: nextLook,
    };
    const validTargetIds = new Set(sectionTargets.map(target => target.id));
    const normalizedDraftLooks = Object.fromEntries(
      Object.entries(draftLookEntries)
        .filter(([targetId]) => validTargetIds.has(targetId))
        .map(([targetId, draftLook]) => [targetId, normalizeSectionVisualLook(draftLook)]),
    );
    const nextDefaultLook = normalizeSectionVisualLook(normalizedDraftLooks[ALL_SECTIONS_TARGET_ID] || savedGlobalLook);
    let nextBoard = board;
    if (normalizedDraftLooks[ALL_SECTIONS_TARGET_ID]) {
      nextBoard = applyLookToPatchBoard({
        patchBoard: nextBoard,
        strips,
        targetId: ALL_SECTIONS_TARGET_ID,
        look: nextDefaultLook,
      });
    }
    for (const target of sectionTargets) {
      if (target.kind !== 'section' || !normalizedDraftLooks[target.id]) continue;
      nextBoard = applyLookToPatchBoard({
        patchBoard: nextBoard,
        strips,
        targetId: target.id,
        look: normalizedDraftLooks[target.id],
      });
    }
    const nextTargets = deriveSectionTargets({ strips, patchBoard: nextBoard, defaultLook: nextDefaultLook });
    let nextController = {
      ...(standaloneController || {}),
      defaultLook: nextDefaultLook,
    };
    if (!saveNamedLook) {
      return { nextLook, nextBoard, nextController, nextTargets };
    }
    const fallbackLabel = comboLabelFromTargets(nextTargets, nextDefaultLook);
    const resolvedLabel = label || lookLabel.trim() || fallbackLabel;
    nextController = saveCurrentLookToController(standaloneController, {
      lookId: uniqueLookId ? `combo-${Date.now()}-${++savedComboSeq.current}` : '',
      label: resolvedLabel,
      defaultLook: nextDefaultLook,
      targets: nextTargets,
    });
    return { nextLook, nextBoard, nextController, nextTargets };
  };

  const commitCurrentLook = ({ label = '' } = {}) => {
    const { nextLook, nextBoard, nextController } = buildCurrentHardwareState({ saveNamedLook: true, label });
    setPatchBoard(nextBoard);
    setStandaloneController(nextController);
    setDraftLooks({});
    setLookLabel('');
    return { nextLook, nextBoard, nextController };
  };

  const saveComboOnly = () => {
    const { nextController } = buildCurrentHardwareState({
      saveNamedLook: true,
      label: lookLabel.trim() || currentComboLabel,
      uniqueLookId: true,
    });
    const nextLooks = normalizeSavedLooks(nextController.looks);
    const saved = nextLooks[0];
    setPatchBoard(applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook: saved }));
    setStandaloneController(nextController);
    setDraftLooks({});
    setLookLabel('');
    setStatusKind('ok');
    setStatus(`${saved?.label || 'Combo'} saved. You can save another Outer and Inner combination now.`);
  };

  const applySplitPreviewToCard = async () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const { nextLook, nextBoard, nextController } = buildCurrentHardwareState();
    const nextPackage = buildCardRuntimePackageFromProject({
      projectName,
      strips,
      patchBoard: nextBoard,
      standaloneController: nextController,
    });
    setStatusKind('');
    setStatus(`Applying split preview to ${cardHostToUrl(cardHost)}...`);
    try {
      await pushConfigToCard(nextPackage, { host: cardHost, timeoutMs: 6000 });
      setPatchBoard(nextBoard);
      setStandaloneController(nextController);
      setDraftLooks({});
      const zone = selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '';
      await pushLivePreviewToCard({ ...nextLook, zone }, { host: cardHost, timeoutMs: 2200 }).catch(() => null);
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('ok');
      setStatus('Split preview is live on the card. Section taps now target Outer and Inner separately.');
    } catch (error) {
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? 'The hosted HTTPS page cannot write split preview to the local card. Open this Studio from localhost, or copy the config to the card page.'
        : `Could not apply split preview to the card at ${cardHostToUrl(cardHost)}.`);
    }
  };

  const savePreviewToCard = async () => {
    const { nextLook, nextBoard, nextController } = commitCurrentLook({});
    const nextPackage = buildCardRuntimePackageFromProject({
      projectName,
      strips,
      patchBoard: nextBoard,
      standaloneController: nextController,
    });
    setStatusKind('');
    setStatus(`Saving ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} to ${cardHostToUrl(cardHost)}...`);
    try {
      await pushConfigToCard(nextPackage, { host: cardHost, timeoutMs: 6000 });
      const zone = selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '';
      await pushLivePreviewToCard({ ...nextLook, zone }, { host: cardHost, timeoutMs: 2200 }).catch(() => null);
      setStatusKind('ok');
      setStatus('Saved on the card. This is now the startup Look and knob cycle config.');
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? 'Saved in the Studio, but the hosted HTTPS page cannot write to the local card. Copy or download the chip config and paste it on the card page.'
        : 'Saved in the Studio, but could not reach the card. Copy or download the chip config and paste it on the card page.');
    }
  };

  const applySavedLook = (savedLook) => {
    const nextBoard = applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook });
    setPatchBoard(nextBoard);
    setStandaloneController(prev => ({
      ...(prev || {}),
      defaultLook: savedLook.defaultLook,
      activeLookId: savedLook.id,
      looks: savedLooks,
    }));
    setDraftLooks({});
    setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    setStatusKind('ok');
    setStatus(`${savedLook.label} applied. Preview or save it to the card when ready.`);
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
            <h1>Patterns & Combos</h1>
            <p>Choose Outer and Inner patterns, tune the colors, then save the pairing as a reusable combo for the card.</p>
          </div>
          <div className="lw-patterns-actions">
            <button type="button" className="btn btn-primary" onClick={applySplitPreviewToCard}>Apply split to card</button>
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
              <span>Tap a pattern to preview</span>
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
              <span>{hasUnsavedPreview ? `${selectedTargetName} not saved` : `${selectedTargetName} saved`}</span>
            </div>
            <div className="lw-combo-bench">
              <div className="lw-combo-bench-copy">
                <span>Current combo</span>
                <strong>{lookLabel.trim() || currentComboLabel}</strong>
                <em>Save this Outer and Inner pairing as an option.</em>
                <input
                  className="lw-search-input"
                  value={lookLabel}
                  onChange={event => setLookLabel(event.target.value)}
                  placeholder="Name this combo (optional)"
                  aria-label="Combo name"
                />
              </div>
              <div className="lw-combo-targets">
                {effectiveSectionTargets.filter(target => target.kind === 'section').map(target => (
                  <span key={target.id}>
                    <LookPreview patternId={target.look?.patternId} look={target.look}/>
                    <b>{target.label}</b>
                    <em>{patternLabel(target.look?.patternId)}</em>
                  </span>
                ))}
              </div>
              <button type="button" className="btn btn-primary" data-testid="save-current-combo" onClick={saveComboOnly}>Save combo</button>
            </div>
            {savedLooks.length > 0 && (
              <div className="lw-combo-library">
                <div className="lw-sec-header">
                  <span>Saved combos</span>
                  <span className="meta">{savedLooks.length} saved</span>
                </div>
                <div className="lw-combo-library-list">
                  {savedLooks.map(savedLook => (
                    <SavedLookCard
                      key={savedLook.id}
                      look={savedLook}
                      targets={sectionTargets}
                      active={savedLook.id === activeLookId}
                      onApply={() => applySavedLook(savedLook)}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="lw-target-panel">
              <div className="lw-sec-header">
                <span>Design target</span>
                <span className="meta">{Math.max(0, sectionTargets.length - 1)} sections · card limit 8</span>
              </div>
              <div className="lw-target-grid">
                {sectionTargets.map(target => (
                  <TargetButton
                    key={target.id}
                    target={target.id === selectedTarget?.id
                      ? { ...target, look }
                      : effectiveSectionTargets.find(effectiveTarget => effectiveTarget.id === target.id) || target}
                    active={target.id === selectedTarget?.id}
                    onSelect={() => setSelectedTargetId(target.id)}
                  />
                ))}
              </div>
            </div>
            <div className="lw-pattern-browse-tools">
              <input
                className="lw-search-input"
                value={patternSearch}
                onChange={event => setPatternSearch(event.target.value)}
                placeholder="Search chip patterns"
              />
              <div className="lw-pattern-filter-row" aria-label="Pattern filters">
                {PATTERN_CATEGORIES.map(category => (
                  <button
                    key={category.id}
                    type="button"
                    className={`btn btn-ghost ${patternCategory === category.id ? 'active' : ''}`}
                    onClick={() => setPatternCategory(category.id)}
                  >
                    {category.label}
                  </button>
                ))}
              </div>
              <span>{filteredPatterns.length} shown</span>
            </div>
            <div className="lw-look-grid">
              {filteredPatterns.map(pattern => (
                <LookCard
                  key={pattern.id}
                  pattern={pattern}
                  look={look}
                  previewing={look.patternId === pattern.id}
                  saved={savedTargetLook.patternId === pattern.id}
                  inCycle={cycleIds.includes(pattern.id)}
                  onSelect={() => updatePreviewLook({ patternId: pattern.id })}
                  onCycleChange={enabled => setCycleEnabled(pattern.id, enabled)}
                />
              ))}
              {!filteredPatterns.length && (
                <p className="lw-pattern-empty">No chip-ready patterns match this search.</p>
              )}
            </div>
          </section>

          <aside className="lw-patterns-aside">
            <Section title="Preview" meta={`${selectedTargetName} · ${selectedPattern?.label || look.patternId}`}>
              <div className="lw-pattern-led-preview" style={{ '--pattern-preview-bg': selectedPattern?.preview }}>
                <LEDPreview
                  patternId={previewPatternId}
                  playing={true}
                  speed={look.speed}
                  glow={1.1}
                  dotSize={3.2}
                  strips={previewStrips}
                  viewBox={viewBox}
                  svgText={svgText}
                  masterBrightness={look.brightness}
                  masterSaturation={Math.max(0.2, look.customSaturation / 255)}
                  masterHueShift={look.hueShift + Math.round((look.customHue - 32) / 2)}
                  motionSmoothing="soft"
                />
              </div>
              <p className="lw-pattern-preview-copy">{selectedPattern?.description}</p>
            </Section>

            <Section title="Color & motion" meta={selectedTargetName}>
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
                <label>
                  <span>Speed</span>
                  <input type="range" min="0.05" max="3" step="0.01" value={look.speed} onChange={event => updatePreviewLook({ speed: +event.target.value })}/>
                </label>
                <label>
                  <span>Hue shift</span>
                  <input type="range" min="-128" max="128" step="1" value={look.hueShift} onChange={event => updatePreviewLook({ hueShift: +event.target.value })}/>
                </label>
              </div>
              <div className="lw-look-switches">
                <label><input type="checkbox" checked={look.customBreathe} onChange={event => updatePreviewLook({ customBreathe: event.target.checked })}/> Breathe</label>
                <label><input type="checkbox" checked={look.customDrift} onChange={event => updatePreviewLook({ customDrift: event.target.checked })}/> Drift</label>
              </div>
            </Section>

            <Section title="Knob" meta={`${cycleIds.length} patterns`}>
              <div className="lw-knob-control-grid">
                <div>
                  <span>Rotate</span>
                  <div className="lw-tweaks-seg">
                    <button
                      type="button"
                      className={controls.encoder.rotateDirection === 'clockwise-brighter' ? 'active' : ''}
                      onClick={() => updateController({ controls: { encoder: { rotateDirection: 'clockwise-brighter' } } })}
                    >
                      Brighter
                    </button>
                    <button
                      type="button"
                      className={controls.encoder.rotateDirection === 'clockwise-dimmer' ? 'active' : ''}
                      onClick={() => updateController({ controls: { encoder: { rotateDirection: 'clockwise-dimmer' } } })}
                    >
                      Dimmer
                    </button>
                  </div>
                </div>
                <label>
                  <span>Step</span>
                  <input
                    type="range"
                    min="1"
                    max="64"
                    step="1"
                    value={controls.encoder.brightnessStep}
                    onChange={event => updateController({ controls: { encoder: { brightnessStep: +event.target.value } } })}
                  />
                  <b>{controls.encoder.brightnessStep}</b>
                </label>
              </div>
            </Section>

            <Section title="Card" meta={`${config.led.pixels} pixels`}>
              <div className="lw-card-load-summary">
                <span>Live preview</span><strong data-testid="card-live-preview-label">{selectedPattern?.label || look.patternId}</strong>
                <span>Editing</span><strong data-testid="card-target-label">{selectedTargetName}</strong>
                <span>Starts with</span><strong data-testid="card-startup-label">{savedPattern?.label || savedGlobalLook.patternId}</strong>
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
