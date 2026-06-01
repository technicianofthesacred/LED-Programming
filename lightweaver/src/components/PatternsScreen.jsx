import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { CARD_RUNTIME_MAX_ZONES, DEFAULT_CARD_CONTROLS, DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { getCardPatternById, getCardPatternFingerprint } from '../lib/cardPatternBank.js';
import {
  cardColorToHex,
  cardHueDeltaToDegrees,
  cardHueToDegrees,
  cardSaturationToChroma,
  hexToCardColor,
} from '../lib/cardVisualLook.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import {
  clampHardwarePixelCount,
  countsFromDefaultCircleLayout,
  createDefaultCircleLayout,
  DEFAULT_CIRCLE_SECTION_COUNT,
  DEFAULT_CIRCLE_TOTAL_PIXELS,
  isDefaultCircleLayout,
} from '../lib/defaultCircleLayout.js';
import { DEFAULT_STANDALONE_OUTPUTS } from '../lib/standaloneController.js';
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
  derivePlaylistLookIds,
  makeComboPlaylistItem,
  makePatternPlaylistItem,
  normalizeCardPlaylist,
  playlistContainsCombo,
  playlistContainsPattern,
  playlistLabels,
} from '../lib/cardPlaylist.js';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { pushConfigToCard } from '../lib/cardPushClient.js';
import { pushLivePreviewToCard, pushSectionPreviewToCard } from '../lib/cardLiveControl.js';
import { LEDPreview } from './Preview.jsx';

const SWATCHES = [8, 22, 36, 54, 78, 112, 145, 172, 198, 222, 238, 252];
const DEFAULT_TUNING = {
  brightness: 1,
  speed: 1,
  hueShift: 0,
  customHue: 32,
  customSaturation: 230,
  customBreathe: false,
  customDrift: false,
};
const GEOMETRY_PRESETS = [
  { id: 'none', label: 'Original', settings: { enabled: false, type: 'none' } },
  { id: 'mirror-hv', label: 'Mirror', settings: { enabled: true, type: 'mirror-hv' } },
  { id: 'radial', label: 'Mandala', settings: { enabled: true, type: 'radial', count: 8, twist: 0 } },
  { id: 'kaleido', label: 'Kaleido', settings: { enabled: true, type: 'kaleido', slices: 6 } },
];
const PATTERN_CATEGORIES = [
  { id: 'all', label: 'All', ids: null },
  { id: 'calm', label: 'Calm', ids: ['aurora', 'breathe', 'calm', 'drift', 'bloom', 'warm-white'] },
  { id: 'water', label: 'Water', ids: ['ocean', 'ripple', 'wave', 'plasma'] },
  { id: 'warm', label: 'Warm', ids: ['fire', 'lava', 'candle', 'ember', 'sunset', 'warm-white'] },
  { id: 'spark', label: 'Spark', ids: ['sparkle', 'twinkle', 'meteor', 'confetti', 'lightning'] },
  { id: 'motion', label: 'Motion', ids: ['chase', 'scanner', 'warp', 'pulse-ring', 'blocks', 'rainbow'] },
  { id: 'electric', label: 'Electric', ids: ['neon', 'matrix', 'heartbeat', 'stained'] },
];
const PREVIEW_LED_COUNT = 34;
const PREVIEW_LED_INDEXES = Array.from({ length: PREVIEW_LED_COUNT }, (_, index) => index);
const MAX_COMBO_PREVIEWS = 3;

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

function LookPreview({ patternId, look, large = false, tuned = false }) {
  const pattern = getCardPatternById(patternId);
  const fingerprint = getCardPatternFingerprint(patternId);
  const tunedLedColor = cardColorToHex(look.customHue, look.customSaturation);
  return (
    <div
      className={`lw-look-preview lw-look-${patternId} ${fingerprint.cssClass} ${large ? 'is-large' : ''}`}
      style={{
        '--look-preview-bg': pattern?.preview,
        '--look-dim': String(0.3 + look.brightness * 0.7),
        '--palette-a': fingerprint.palette[0],
        '--palette-b': fingerprint.palette[1],
        '--palette-c': fingerprint.palette[2],
        '--palette-d': fingerprint.palette[3] || fingerprint.palette[0],
      }}
      aria-hidden="true"
    >
      <span className="lw-look-led-field">
        {PREVIEW_LED_INDEXES.map(index => {
          const point = previewLedPoint(index, PREVIEW_LED_COUNT, fingerprint.cssClass);
          return (
            <i
              key={index}
              style={{
                '--x': `${point.x}%`,
                '--y': `${point.y}%`,
                '--delay': `${point.delay}s`,
                '--scale': point.scale,
                '--led-color': tuned ? tunedLedColor : fingerprint.palette[index % fingerprint.palette.length],
              }}
            />
          );
        })}
      </span>
      <span className="lw-look-scan"/>
    </div>
  );
}

function PatternFingerprint({ fingerprint, compact = false }) {
  return (
    <span className={`lw-pattern-fingerprint ${compact ? 'is-compact' : ''}`}>
      <span className="lw-pattern-palette" aria-hidden="true">
        {fingerprint.palette.slice(0, 5).map((color, index) => (
          <i key={`${color}-${index}`} style={{ '--swatch': color }}/>
        ))}
      </span>
      <span className="lw-pattern-fingerprint-copy">
        <b>{fingerprint.motionLabel}</b>
        <em>{fingerprint.tempoLabel} / {fingerprint.intensityLabel}</em>
      </span>
    </span>
  );
}

function previewLedPoint(index, count, cssClass) {
  const t = count > 1 ? index / (count - 1) : 0.5;
  const phase = t * Math.PI * 2;
  if (cssClass === 'motion-ring' || cssClass === 'motion-pulse' || cssClass === 'motion-pane') {
    return {
      x: 50 + Math.cos(phase) * 33,
      y: 50 + Math.sin(phase) * 22,
      delay: -t * 2.8,
      scale: 0.82 + Math.sin(phase + 0.7) * 0.14,
    };
  }
  if (cssClass === 'motion-rain') {
    const col = index % 7;
    const row = Math.floor(index / 7);
    return {
      x: 15 + col * 11.5 + (row % 2) * 2,
      y: 16 + row * 15,
      delay: -(row * 0.22 + col * 0.07),
      scale: 0.78 + ((index % 3) * 0.1),
    };
  }
  if (cssClass === 'motion-organic' || cssClass === 'motion-liquid' || cssClass === 'motion-breathe') {
    return {
      x: 12 + t * 76,
      y: 50 + Math.sin(phase * 1.25) * 16 + Math.sin(phase * 2.1) * 5,
      delay: -t * 3.6,
      scale: 0.76 + Math.sin(phase * 1.8) * 0.2,
    };
  }
  if (cssClass === 'motion-spark' || cssClass === 'motion-strike' || cssClass === 'motion-flicker') {
    const col = index % 9;
    const row = Math.floor(index / 9);
    return {
      x: 10 + col * 10 + ((row * 7) % 9),
      y: 19 + row * 18 + ((index * 11) % 7),
      delay: -((index * 0.13) % 2.4),
      scale: 0.72 + ((index % 4) * 0.12),
    };
  }
  if (cssClass === 'motion-comet' || cssClass === 'motion-chase' || cssClass === 'motion-scan' || cssClass === 'motion-warp') {
    return {
      x: 10 + t * 80,
      y: 50 + Math.sin(phase) * 9,
      delay: -t * 2.2,
      scale: 0.78 + t * 0.22,
    };
  }
  return {
    x: 10 + t * 80,
    y: 50 + Math.sin(phase * 1.5) * 13,
    delay: -t * 3,
    scale: 0.82 + Math.sin(phase) * 0.1,
  };
}

function TuningSlider({ label, testId, min, max, step, value, readout, onChange }) {
  const readoutId = testId.replace(/-slider$/, '-readout');
  return (
    <label className="lw-look-slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        aria-label={label}
        onChange={event => onChange(Number(event.target.value))}
      />
      <strong data-testid={readoutId}>{readout}</strong>
    </label>
  );
}

function geometryTypeFromSettings(settings = {}) {
  return settings?.enabled && settings.type !== 'none' ? settings.type : 'none';
}

function clampByte(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, n));
}

function randomLookTuning() {
  return {
    customHue: Math.floor(Math.random() * 256),
    customSaturation: 120 + Math.floor(Math.random() * 136),
    brightness: 0.58 + Math.random() * 0.42,
    speed: 0.45 + Math.random() * 1.9,
    hueShift: Math.floor(Math.random() * 121) - 60,
    customBreathe: Math.random() > 0.55,
    customDrift: Math.random() > 0.72,
  };
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
    if (sections.length > 2) return `${sections.length}-section combo`;
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

function LookCard({ pattern, look, previewing, saved, inPlaylist, livePreviewAvailable, onSelect, onPlaylistChange }) {
  const fingerprint = getCardPatternFingerprint(pattern.id);
  const summary = previewing
    ? saved ? 'Previewing and saved here' : livePreviewAvailable ? 'Previewing on LEDs' : 'Previewing in Studio'
    : saved ? 'Saved for this target' : pattern.description || 'Tap to preview this look';
  return (
    <article className={`lw-look-card ${saved ? 'is-selected' : ''} ${previewing ? 'is-previewing' : ''}`}>
      <button type="button" className="lw-look-card-main" data-pattern-id={pattern.id} onClick={onSelect}>
        <LookPreview patternId={pattern.id} look={{ ...look, patternId: pattern.id }} tuned={previewing || saved}/>
        <span className="lw-look-card-copy">
          <strong>{pattern.label}</strong>
          <span>{summary}</span>
          <PatternFingerprint fingerprint={fingerprint} compact/>
        </span>
      </button>
      <label className="lw-look-card-toggle">
        <input type="checkbox" checked={inPlaylist} onChange={event => onPlaylistChange(event.target.checked)}/>
        <span>In playlist</span>
      </label>
    </article>
  );
}

function TargetButton({
  target,
  active,
  editable,
  onSelect,
  onNameChange,
  onPixelCountChange,
}) {
  const pattern = getCardPatternById(target.look?.patternId);
  const readOnlyName = target.kind === 'all';
  const onInputClick = event => event.stopPropagation();
  return (
    <div
      role="button"
      tabIndex={0}
      className={`lw-section-target ${active ? 'is-active' : ''}`}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      data-testid={`section-target-${target.id}`}
    >
      <span className="lw-section-target-main">
        <input
          className="lw-target-name-input"
          value={target.label}
          readOnly={readOnlyName}
          aria-label={`${target.label} name`}
          data-testid={`section-target-name-${target.id}`}
          onClick={onInputClick}
          onFocus={onSelect}
          onChange={event => onNameChange?.(target, event.target.value)}
        />
        <span className="lw-target-led-row">
          <input
            className="lw-target-led-input"
            type="number"
            min="1"
            max="2048"
            value={target.pixelCount || 1}
            disabled={!editable}
            aria-label={`${target.label} LEDs`}
            data-testid={`section-target-leds-${target.id}`}
            onClick={onInputClick}
            onFocus={onSelect}
            onChange={event => onPixelCountChange?.(target, event.target.value)}
          />
          <em>{target.kind === 'all' ? 'LEDs whole piece' : 'LEDs'}</em>
        </span>
      </span>
      <b>{pattern?.label || target.look?.patternId || 'Pattern'}</b>
    </div>
  );
}

function SavedLookCard({ look, active, inPlaylist, onApply, onLoadToCard, onAddToPlaylist, targets = [] }) {
  const targetById = new Map(targets.map(target => [target.id, target]));
  const sectionSummaries = Object.entries(look.sectionLooks || {}).map(([targetId, sectionLook]) => ({
    id: targetId,
    label: targetById.get(targetId)?.label || titleFromId(targetId),
    look: normalizeSectionVisualLook(sectionLook),
  }));
  const sectionCount = sectionSummaries.length;
  const allPreviewSections = sectionSummaries.length
    ? sectionSummaries
    : [{ id: 'all', label: 'All', look: look.defaultLook }];
  const previewSections = allPreviewSections.slice(0, MAX_COMBO_PREVIEWS);
  const hiddenPreviewCount = Math.max(0, allPreviewSections.length - previewSections.length);
  const previewItemCount = previewSections.length + (hiddenPreviewCount > 0 ? 1 : 0);
  const previewCols = Math.min(4, Math.max(1, previewItemCount));
  return (
    <article
      className={`lw-saved-look-card ${active ? 'is-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onApply}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onApply();
        }
      }}
    >
      <span
        className="lw-saved-combo-previews"
        style={{ '--combo-preview-cols': previewCols }}
        aria-hidden="true"
      >
        {previewSections.map(section => (
          <LookPreview key={section.id} patternId={section.look?.patternId} look={section.look} tuned/>
        ))}
        {hiddenPreviewCount > 0 && <span className="lw-saved-combo-overflow">+{hiddenPreviewCount}</span>}
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
      <span className="lw-saved-combo-actions">
        <button
          type="button"
          className="btn btn-primary lw-saved-combo-load"
          onClick={event => {
            event.stopPropagation();
            onAddToPlaylist?.(look);
          }}
        >
          {inPlaylist ? 'In playlist' : 'Add to playlist'}
        </button>
        <button
          type="button"
          className="btn btn-ghost lw-saved-combo-load"
          onClick={event => {
            event.stopPropagation();
            onLoadToCard?.(look);
          }}
        >
          Load now
        </button>
      </span>
    </article>
  );
}

export function PatternsScreen() {
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
    symSettings,
    setSymSettings,
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
  const livePreviewAvailable = typeof window === 'undefined' ? false : canPushDirectlyToCard(window.location.protocol);
  const savedComboSeq = useRef(0);

  const savedGlobalLook = normalizeSectionVisualLook(standaloneController?.defaultLook);
  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const activeLookId = standaloneController?.activeLookId || '';
  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const defaultLayoutActive = isDefaultCircleLayout(strips);
  const editableTargetLayout = !svgText && (defaultLayoutActive || strips.length === 0);
  const defaultSectionCounts = defaultLayoutActive ? countsFromDefaultCircleLayout(strips) : [];
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
  const playlist = normalizeCardPlaylist(standaloneController?.playlist, {
    savedLooks,
    fallbackPatternIds: [
      savedGlobalLook.patternId,
      ...(Array.isArray(controls.encoder.patternCycleIds) ? controls.encoder.patternCycleIds : []),
    ],
  });
  const playlistIds = derivePlaylistLookIds(playlist);
  const playlistSummary = playlistLabels(playlist, 4).join(', ');
  const selectedPattern = getCardPatternById(look.patternId) || DEFAULT_CARD_PATTERN_BANK[0];
  const selectedFingerprint = getCardPatternFingerprint(selectedPattern.id);
  const previewPatternId = selectedPattern?.previewPatternId || selectedPattern?.id || look.patternId;
  const savedPattern = getCardPatternById(savedGlobalLook.patternId) || DEFAULT_CARD_PATTERN_BANK[0];
  const hasUnsavedPreview = !looksMatch(look, savedTargetLook);
  const selectedTargetName = selectedTarget ? targetLabel(selectedTarget) : 'All sections';
  const currentComboLabel = comboLabelFromTargets(effectiveSectionTargets, draftDefaultLook);
  const colorHex = cardColorToHex(look.customHue, look.customSaturation);
  const geometryType = geometryTypeFromSettings(symSettings);
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
  const applyDefaultTargetLayout = useCallback(({
    totalPixels = null,
    sectionPixelCounts = null,
  } = {}) => {
    if (!editableTargetLayout) return;
    const currentCounts = defaultSectionCounts.length
      ? defaultSectionCounts
      : (strips || []).map(strip => strip.pixelCount || strip.pixels?.length || 1);
    const currentTotal = currentCounts.reduce((sum, count) => sum + count, 0) || config.led.pixels || DEFAULT_CIRCLE_TOTAL_PIXELS;
    const counts = Array.isArray(sectionPixelCounts) && sectionPixelCounts.length
      ? sectionPixelCounts.map((count, index) => clampHardwarePixelCount(count, currentCounts[index] || 1))
      : null;
    const nextTotal = counts
      ? counts.reduce((sum, count) => sum + count, 0)
      : clampHardwarePixelCount(totalPixels ?? currentTotal, currentTotal);
    const sectionCount = counts?.length || currentCounts.length || DEFAULT_CIRCLE_SECTION_COUNT;
    const namesById = new Map((strips || []).map(strip => [strip.id, strip.name]));
    const nextStrips = createDefaultCircleLayout({
      totalPixels: nextTotal,
      sectionCount,
      sectionPixelCounts: counts,
      viewBox: viewBox || '0 0 640 400',
    }).map(strip => ({
      ...strip,
      name: namesById.get(strip.id) || strip.name,
    }));
    const nextBoard = normalizePatchBoard(board, nextStrips);

    setViewBox(viewBox || '0 0 640 400');
    setStrips(nextStrips);
    setPatchBoard(nextBoard);
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
  }, [
    board,
    config.led.pixels,
    defaultSectionCounts,
    editableTargetLayout,
    setPatchBoard,
    setStandaloneController,
    setStrips,
    setViewBox,
    strips,
    viewBox,
  ]);

  const updateTargetName = useCallback((target, value) => {
    if (!target || target.kind !== 'section') return;
    const nextName = String(value || '').slice(0, 48);
    setStrips(prev => (prev || []).map(strip => (
      strip.id === target.stripId ? { ...strip, name: nextName } : strip
    )));
    setPatchBoard(prev => {
      const nextBoard = normalizePatchBoard(prev, strips);
      nextBoard.patches = (nextBoard.patches || []).map(patch => (
        patch.id === target.patchId ? { ...patch, name: nextName } : patch
      ));
      return nextBoard;
    });
  }, [setPatchBoard, setStrips, strips]);

  const updateTargetPixelCount = useCallback((target, value) => {
    if (!editableTargetLayout || !target || value === '') return;
    if (target.kind === 'all') {
      applyDefaultTargetLayout({ totalPixels: value });
      return;
    }
    const index = (strips || []).findIndex(strip => strip.id === target.stripId);
    if (index < 0) return;
    const fallbackCount = Math.max(
      1,
      Math.floor((config.led.pixels || DEFAULT_CIRCLE_TOTAL_PIXELS) / Math.max(1, strips.length || DEFAULT_CIRCLE_SECTION_COUNT)),
    );
    const counts = defaultSectionCounts.length
      ? [...defaultSectionCounts]
      : (strips || []).map(strip => strip.pixelCount || strip.pixels?.length || fallbackCount);
    counts[index] = clampHardwarePixelCount(value, counts[index] || fallbackCount);
    applyDefaultTargetLayout({ sectionPixelCounts: counts });
  }, [
    applyDefaultTargetLayout,
    config.led.pixels,
    defaultSectionCounts,
    editableTargetLayout,
    strips,
  ]);

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
    if (!livePreviewAvailable) {
      setStatusKind('err');
      setStatus('The hosted HTTPS page cannot talk directly to local HTTP hardware. Open this Studio from localhost, or copy the config to the card page.');
      return;
    }
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const zone = target?.kind === 'section' ? target.zoneId || target.id : '';
    livePreviewTimer.current = setTimeout(async () => {
      setStatusKind('');
      setStatus(`Previewing ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} on ${targetLabel(target)} at ${cardHostToUrl(cardHost)}...`);
      try {
        const response = await pushLivePreviewToCard(
          { ...nextLook, zone, syncZones: target?.kind === 'section' ? false : true },
          { host: cardHost, timeoutMs: 2200, fallbackMissingZoneToAll: true },
        );
        if (sequence === livePreviewSeq.current) {
          setStatusKind('ok');
          const patternLabel = getCardPatternById(nextLook.patternId)?.label || nextLook.patternId;
          setStatus(response?.previewZoneFallback
            ? `Previewing ${patternLabel} on the whole card. Save these Settings to the card once to preview ${targetLabel(target)} separately.`
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
  }, [cardHost, livePreviewAvailable, livePreviewEnabled, selectedTarget]);

  useEffect(() => () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
  }, []);

  const updatePreviewLook = (patch, { push = true } = {}) => {
    if (!selectedTarget) return;
    const nextLook = normalizeSectionVisualLook({ ...look, ...patch });
    setDraftLooks(prev => ({ ...prev, [selectedTarget.id]: nextLook }));
    if (push) scheduleLivePreview(nextLook, selectedTarget);
  };

  const updateGeometry = (settings) => {
    setSymSettings(prev => ({ ...(prev || {}), ...settings }));
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
      const response = await pushConfigToCard(nextPackage, { host: cardHost, timeoutMs: 6000, reboot: 'if-needed' });
      setPatchBoard(nextBoard);
      setStandaloneController(nextController);
      setDraftLooks({});
      if (response.rebooting) {
        if (sequence !== livePreviewSeq.current) return;
        setStatusKind('ok');
        setStatus('Split preview was saved. The card is rebooting now so the LED output layout takes effect.');
        return;
      }
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
    const { nextLook, nextBoard, nextController: savedController } = commitCurrentLook({});
    const nextController = promotePatternFirst(savedController, nextLook.patternId);
    setStandaloneController(nextController);
    const nextPackage = buildCardRuntimePackageFromProject({
      projectName,
      strips,
      patchBoard: nextBoard,
      standaloneController: nextController,
    });
    setStatusKind('');
    setStatus(`Saving ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} to ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await pushConfigToCard(nextPackage, { host: cardHost, timeoutMs: 6000, reboot: 'if-needed' });
      if (response.rebooting) {
        setStatusKind('ok');
        setStatus('Saved on the card. The card is rebooting now so the LED output layout takes effect.');
        return;
      }
      const zone = selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '';
      await pushLivePreviewToCard({ ...nextLook, zone }, { host: cardHost, timeoutMs: 2200 }).catch(() => null);
      setStatusKind('ok');
      setStatus('Saved on the card. This is now the startup look and playlist config.');
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? 'Saved in the Studio, but the hosted HTTPS page cannot write to the local card. Copy or download the chip config and paste it on the card page.'
        : 'Saved in the Studio, but could not reach the card. Copy or download the chip config and paste it on the card page.');
    }
  };

  const applySavedLook = async (savedLook) => {
    const nextBoard = applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook });
    const nextTargets = deriveSectionTargets({
      strips,
      patchBoard: nextBoard,
      defaultLook: savedLook.defaultLook,
    });
    setPatchBoard(nextBoard);
    setStandaloneController(prev => ({
      ...(prev || {}),
      defaultLook: savedLook.defaultLook,
      activeLookId: savedLook.id,
      looks: savedLooks,
    }));
    setDraftLooks({});
    setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    if (!livePreviewEnabled) {
      setStatusKind('ok');
      setStatus(`${savedLook.label} applied. Turn on LED preview or save it to the card when ready.`);
      return;
    }

    setStatusKind('');
    setStatus(`Previewing ${savedLook.label} on ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await pushSectionPreviewToCard(nextTargets, { host: cardHost, timeoutMs: 2200 });
      setStatusKind('ok');
      setStatus(response?.previewZoneFallback
        ? `${savedLook.label} applied in Studio. Save these Settings to the card once to preview sections separately.`
        : `${savedLook.label} previewing on the card. Save to card when ready.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? 'The hosted HTTPS page cannot talk directly to local HTTP hardware. Open this Studio from localhost, or copy the config to the card page.'
        : `Could not preview ${savedLook.label} on the card at ${cardHostToUrl(cardHost)}.`);
    }
  };

  const loadSavedLookToCard = async (savedLook) => {
    const nextBoard = applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook });
    const nextController = promoteComboFirst({
      ...(standaloneController || {}),
      defaultLook: normalizeSectionVisualLook(savedLook.defaultLook),
      activeLookId: savedLook.id,
      looks: savedLooks,
    }, savedLook);
    const nextPackage = buildCardRuntimePackageFromProject({
      projectName,
      strips,
      patchBoard: nextBoard,
      standaloneController: nextController,
    });
    setPatchBoard(nextBoard);
    setStandaloneController(nextController);
    setDraftLooks({});
    setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    setStatusKind('');
    setStatus(`Loading ${savedLook.label} to ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await pushConfigToCard(nextPackage, { host: cardHost, timeoutMs: 6000, reboot: 'if-needed' });
      setStatusKind('ok');
      setStatus(response.rebooting
        ? `${savedLook.label} loaded. The card is rebooting so the LED layout takes effect.`
        : `${savedLook.label} loaded on the card.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? 'The hosted HTTPS page cannot load this combo to the local card. Open this Studio from localhost, or download the chip config.'
        : `Could not load ${savedLook.label} to the card at ${cardHostToUrl(cardHost)}.`);
    }
  };

  const writePlaylist = (nextItems, message = '') => {
    const normalized = normalizeCardPlaylist(nextItems, {
      savedLooks,
      fallbackPatternIds: [savedGlobalLook.patternId],
    });
    updateController({
      playlist: normalized,
      controls: { encoder: { patternCycleIds: derivePlaylistLookIds(normalized) } },
    });
    if (message) {
      setStatusKind('ok');
      setStatus(message);
    }
  };

  const setPatternInPlaylist = (patternId, enabled) => {
    const pattern = getCardPatternById(patternId);
    const next = enabled
      ? playlistContainsPattern(playlist, patternId)
        ? playlist
        : [...playlist, makePatternPlaylistItem(patternId)].filter(Boolean)
      : playlist.filter(item => !(item.type === 'pattern' && item.patternId === patternId));
    writePlaylist(next, enabled
      ? `${pattern?.label || patternId} added to the Playlist.`
      : `${pattern?.label || patternId} removed from the Playlist.`);
  };

  const addSavedLookToPlaylist = (savedLook) => {
    if (playlistContainsCombo(playlist, savedLook.id)) {
      setStatusKind('');
      setStatus(`${savedLook.label} is already in the Playlist.`);
      return;
    }
    const item = makeComboPlaylistItem(savedLook);
    if (!item) return;
    writePlaylist([...playlist, item], `${savedLook.label} added to the Playlist.`);
  };

  const promotePatternFirst = (controller, patternId) => {
    const controllerLooks = normalizeSavedLooks(controller?.looks);
    const currentPlaylist = normalizeCardPlaylist(controller?.playlist, {
      savedLooks: controllerLooks,
      fallbackPatternIds: [
        patternId,
        ...(Array.isArray(controller?.controls?.encoder?.patternCycleIds) ? controller.controls.encoder.patternCycleIds : []),
      ],
    });
    const item = makePatternPlaylistItem(patternId);
    const nextPlaylist = normalizeCardPlaylist([
      item,
      ...currentPlaylist.filter(entry => !(entry.type === 'pattern' && entry.patternId === patternId)),
    ].filter(Boolean), { savedLooks: controllerLooks, fallbackPatternIds: [patternId] });
    return {
      ...(controller || {}),
      playlist: nextPlaylist,
      controls: {
        ...(controller?.controls || {}),
        encoder: {
          ...(controller?.controls?.encoder || {}),
          patternCycleIds: derivePlaylistLookIds(nextPlaylist),
        },
      },
    };
  };

  const promoteComboFirst = (controller, savedLook) => {
    const controllerLooks = normalizeSavedLooks(controller?.looks);
    const currentPlaylist = normalizeCardPlaylist(controller?.playlist, {
      savedLooks: controllerLooks,
      fallbackPatternIds: [normalizeSectionVisualLook(savedLook?.defaultLook).patternId],
    });
    const item = makeComboPlaylistItem(savedLook);
    const nextPlaylist = normalizeCardPlaylist([
      item,
      ...currentPlaylist.filter(entry => !(entry.type === 'combo' && entry.lookId === savedLook.id)),
    ].filter(Boolean), { savedLooks: controllerLooks, fallbackPatternIds: [normalizeSectionVisualLook(savedLook?.defaultLook).patternId] });
    return {
      ...(controller || {}),
      playlist: nextPlaylist,
      controls: {
        ...(controller?.controls || {}),
        encoder: {
          ...(controller?.controls?.encoder || {}),
          patternCycleIds: derivePlaylistLookIds(nextPlaylist),
        },
      },
    };
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
            <p>Choose section patterns, tune the colors, then save the result as a reusable combo for the card.</p>
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
              <span className="meta">{DEFAULT_CARD_PATTERN_BANK.length} chip-ready / {playlist.length} in playlist</span>
            </div>
            <div className="lw-live-preview-bar">
              <label>
                <input
                  type="checkbox"
                  checked={livePreviewEnabled}
                  disabled={!livePreviewAvailable}
                  onChange={event => setLivePreviewEnabled(event.target.checked)}
                />
                {livePreviewAvailable ? 'Preview taps on the LED card' : 'Studio preview only'}
              </label>
              <span>{hasUnsavedPreview ? `${selectedTargetName} not saved` : `${selectedTargetName} saved`}</span>
            </div>
            <div className="lw-combo-bench">
              <div className="lw-combo-bench-copy">
                <span>Current combo</span>
                <strong>{lookLabel.trim() || currentComboLabel}</strong>
                <em>Save this section setup as an option.</em>
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
                    <LookPreview patternId={target.look?.patternId} look={target.look} tuned/>
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
                      inPlaylist={playlistContainsCombo(playlist, savedLook.id)}
                      onApply={() => applySavedLook(savedLook)}
                      onLoadToCard={() => loadSavedLookToCard(savedLook)}
                      onAddToPlaylist={() => addSavedLookToPlaylist(savedLook)}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="lw-target-panel">
              <div className="lw-sec-header">
                <span>Design target</span>
                <span className="meta">{Math.max(0, sectionTargets.length - 1)} sections · card limit {CARD_RUNTIME_MAX_ZONES}</span>
              </div>
              <div className="lw-target-grid">
                {sectionTargets.map(target => (
                  <TargetButton
                    key={target.id}
                    target={target.id === selectedTarget?.id
                      ? { ...target, look }
                      : effectiveSectionTargets.find(effectiveTarget => effectiveTarget.id === target.id) || target}
                    active={target.id === selectedTarget?.id}
                    editable={editableTargetLayout}
                    onSelect={() => setSelectedTargetId(target.id)}
                    onNameChange={updateTargetName}
                    onPixelCountChange={updateTargetPixelCount}
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
                      inPlaylist={playlistContainsPattern(playlist, pattern.id)}
                      livePreviewAvailable={livePreviewAvailable}
                      onSelect={() => updatePreviewLook({ patternId: pattern.id })}
                      onPlaylistChange={enabled => setPatternInPlaylist(pattern.id, enabled)}
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
                  masterSaturation={look.customSaturation / 255}
                  masterHueShift={cardHueDeltaToDegrees(look.hueShift + (look.customHue - 32))}
                  symSettings={symSettings?.enabled ? symSettings : null}
                  motionSmoothing="soft"
                />
              </div>
              <p className="lw-pattern-preview-copy">{selectedPattern?.description}</p>
            </Section>

            <Section title="Color & motion" meta={selectedTargetName}>
              <LookPreview patternId={look.patternId} look={look} large tuned/>
              <PatternFingerprint fingerprint={selectedFingerprint}/>
              <div className="lw-look-color-picker">
                <label>
                  <span>Pick color</span>
                  <input
                    type="color"
                    value={colorHex}
                    data-testid="look-color-picker"
                    aria-label="Pick color"
                    onChange={event => updatePreviewLook(hexToCardColor(event.target.value, look))}
                  />
                </label>
                <span className="lw-look-color-current" style={{ '--swatch': colorHex }}>
                  <strong>{cardHueToDegrees(look.customHue)} deg</strong>
                  <em>{Math.round((look.customSaturation / 255) * 100)}%</em>
                </span>
              </div>
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
                <TuningSlider
                  label="Hue"
                  testId="look-hue-slider"
                  min="0"
                  max="255"
                  step="1"
                  value={look.customHue}
                  readout={`${cardHueToDegrees(look.customHue)} deg`}
                  onChange={customHue => updatePreviewLook({ customHue: clampByte(customHue) })}
                />
                <TuningSlider
                  label="Color"
                  testId="look-saturation-slider"
                  min="0"
                  max="255"
                  step="1"
                  value={look.customSaturation}
                  readout={`${Math.round((look.customSaturation / 255) * 100)}%`}
                  onChange={customSaturation => updatePreviewLook({ customSaturation: clampByte(customSaturation) })}
                />
                <TuningSlider
                  label="Brightness"
                  testId="look-brightness-slider"
                  min="0.05"
                  max="1"
                  step="0.01"
                  value={look.brightness}
                  readout={`${Math.round(look.brightness * 100)}%`}
                  onChange={brightness => updatePreviewLook({ brightness })}
                />
                <TuningSlider
                  label="Speed"
                  testId="look-speed-slider"
                  min="0.05"
                  max="3"
                  step="0.01"
                  value={look.speed}
                  readout={`${look.speed.toFixed(2)}x`}
                  onChange={speed => updatePreviewLook({ speed })}
                />
                <TuningSlider
                  label="Shift"
                  testId="look-hue-shift-slider"
                  min="-128"
                  max="128"
                  step="1"
                  value={look.hueShift}
                  readout={String(look.hueShift)}
                  onChange={hueShift => updatePreviewLook({ hueShift })}
                />
              </div>
              <div className="lw-look-switches">
                <label><input type="checkbox" checked={look.customBreathe} onChange={event => updatePreviewLook({ customBreathe: event.target.checked })}/> Breathe</label>
                <label><input type="checkbox" checked={look.customDrift} onChange={event => updatePreviewLook({ customDrift: event.target.checked })}/> Drift</label>
              </div>
              <div className="lw-look-tune-actions">
                <button type="button" className="btn btn-ghost" onClick={() => updatePreviewLook(DEFAULT_TUNING)}>Reset</button>
                <button type="button" className="btn btn-ghost" onClick={() => updatePreviewLook(randomLookTuning())}>Randomize</button>
              </div>
            </Section>

            <Section title="Geometry" meta={geometryType}>
              <div className="lw-geometry-presets">
                {GEOMETRY_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    type="button"
                    className={geometryType === preset.id ? 'active' : ''}
                    onClick={() => updateGeometry(preset.settings)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {geometryType.startsWith('mirror') && (
                <div className="lw-geometry-segmented" aria-label="Mirror axis">
                  {[
                    ['mirror-h', 'Top/bottom'],
                    ['mirror-v', 'Left/right'],
                    ['mirror-hv', 'Both'],
                  ].map(([type, label]) => (
                    <button
                      key={type}
                      type="button"
                      className={geometryType === type ? 'active' : ''}
                      onClick={() => updateGeometry({ enabled: true, type })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {geometryType === 'radial' && (
                <div className="lw-geometry-counts" aria-label="Mandala repeats">
                  {[3, 4, 5, 6, 8, 12].map(count => (
                    <button
                      key={count}
                      type="button"
                      className={(symSettings?.count || 8) === count ? 'active' : ''}
                      onClick={() => updateGeometry({ enabled: true, type: 'radial', count })}
                    >
                      {count}
                    </button>
                  ))}
                </div>
              )}
              {geometryType === 'kaleido' && (
                <TuningSlider
                  label="Slices"
                  testId="look-kaleido-slices-slider"
                  min="2"
                  max="16"
                  step="1"
                  value={symSettings?.slices || 6}
                  readout={String(symSettings?.slices || 6)}
                  onChange={slices => updateGeometry({ enabled: true, type: 'kaleido', slices })}
                />
              )}
            </Section>

            <Section title="Knob brightness" meta={`${playlist.length} playlist looks`}>
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
                <span>Playlist</span><strong data-testid="card-knob-cycle-label">{playlistSummary || playlistIds.join(', ')}</strong>
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
