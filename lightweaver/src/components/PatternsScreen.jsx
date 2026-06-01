import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { CARD_RUNTIME_MAX_ZONES, DEFAULT_CARD_CONTROLS, DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import {
  CORE_CARD_PATTERN_BANK,
  getCardPatternById,
  getCardPatternFingerprint,
  getCardPatternRuntimeId,
} from '../lib/cardPatternBank.js';
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
  isImplicitDefaultPatternPlaylist,
  makeComboPlaylistItem,
  makePatternPlaylistItem,
  normalizeCardPlaylist,
  playlistContainsCombo,
  playlistContainsPattern,
  playlistLabels,
} from '../lib/cardPlaylist.js';
import {
  cardHostToUrl,
  discoverCardStatus,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardConfigHandoffUrl, pushConfigToCard } from '../lib/cardPushClient.js';
import {
  buildMirroredLedRepairPackage,
  identifyCardLights,
  pushLiveHardwareToCard,
  pushLivePreviewToCard,
  pushSectionPreviewToCard,
  recoverCardLights,
  repairMirroredLedOutputOnCard,
} from '../lib/cardLiveControl.js';
import { COLOR_ORDERS, normalizeUsbLedColorOrder } from '../lib/usbLedColorOrder.js';
import {
  bootstrapCardBridgeFromOpener,
  cardBridgeAutoPreviewEnabled,
  CARD_BRIDGE_CHANGED_EVENT,
  getCardBridgeState,
  openCardBridge,
  readLocalChipDefault,
  writeLocalChipDefault,
} from '../lib/cardBridge.js';
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
  { id: 'compound', label: 'Compounds', ids: null, compoundOnly: true },
  { id: 'calm', label: 'Calm', ids: ['aurora', 'breathe', 'calm', 'drift', 'bloom', 'warm-white'] },
  { id: 'water', label: 'Water', ids: ['ocean', 'ripple', 'wave', 'plasma'] },
  { id: 'warm', label: 'Warm', ids: ['fire', 'lava', 'candle', 'ember', 'sunset', 'warm-white'] },
  { id: 'spark', label: 'Spark', ids: ['sparkle', 'twinkle', 'meteor', 'confetti', 'lightning'] },
  { id: 'motion', label: 'Motion', ids: ['chase', 'scanner', 'warp', 'pulse-ring', 'blocks', 'rainbow'] },
  { id: 'electric', label: 'Electric', ids: ['neon', 'matrix', 'heartbeat', 'stained'] },
];
const SMALL_PREVIEW_LED_COUNT = 16;
const LARGE_PREVIEW_LED_COUNT = 34;
const INITIAL_PATTERN_VISIBLE_COUNT = CORE_CARD_PATTERN_BANK.length;
const PATTERN_LOAD_BATCH_SIZE = 24;
const RECOVERY_MIN_BRIGHTNESS = 0.65;
const DEFAULT_LAYOUT_OVERWRITE_MIN_PIXELS = 100;
const PATTERN_PREVIEW_MAX_POINTS = 384;
const STRIP_COLOR_TESTS = [
  { id: 'test-red', label: 'Red', shortLabel: 'R', brightness: 1 },
  { id: 'test-green', label: 'Green', shortLabel: 'G', brightness: 1 },
  { id: 'test-blue', label: 'Blue', shortLabel: 'B', brightness: 1 },
  { id: 'test-white', label: 'White', shortLabel: 'W', brightness: 0.55 },
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

function LookPreview({ patternId, look, large = false, tuned = false }) {
  const pattern = getCardPatternById(patternId);
  const fingerprint = getCardPatternFingerprint(patternId);
  const tunedLedColor = cardColorToHex(look.customHue, look.customSaturation);
  const ledCount = large ? LARGE_PREVIEW_LED_COUNT : SMALL_PREVIEW_LED_COUNT;
  const ledIndexes = Array.from({ length: ledCount }, (_, index) => index);
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
        {ledIndexes.map(index => {
          const point = previewLedPoint(index, ledCount, fingerprint.cssClass);
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

function PatternThumbnail({ pattern, fingerprint }) {
  return (
    <span
      className={`lw-pattern-thumb ${fingerprint.cssClass}`}
      style={{
        '--pattern-thumb-bg': pattern?.preview,
        '--palette-a': fingerprint.palette[0],
        '--palette-b': fingerprint.palette[1],
        '--palette-c': fingerprint.palette[2],
        '--palette-d': fingerprint.palette[3] || fingerprint.palette[0],
      }}
      aria-hidden="true"
    >
      <span className="lw-pattern-thumb-glow"/>
      <span className="lw-pattern-thumb-swatch-row">
        {fingerprint.palette.slice(0, 4).map((color, index) => (
          <b key={`${color}-${index}`} style={{ '--swatch': color }}/>
        ))}
      </span>
    </span>
  );
}

function CompoundThumbnail({ look, targets = [] }) {
  const sections = compoundSectionsForLook(look, targets);
  const visibleSections = sections.slice(0, 4);
  return (
    <span
      className="lw-compound-thumb"
      style={{ '--compound-cols': Math.min(4, Math.max(1, visibleSections.length)) }}
      aria-hidden="true"
    >
      {visibleSections.map(section => {
        const pattern = getCardPatternById(section.look?.patternId) || DEFAULT_CARD_PATTERN_BANK[0];
        const fingerprint = getCardPatternFingerprint(pattern.id);
        return (
          <span
            key={section.id}
            className={`lw-compound-thumb-cell ${fingerprint.cssClass}`}
            style={{
              '--pattern-thumb-bg': pattern?.preview,
              '--palette-a': fingerprint.palette[0],
              '--palette-b': fingerprint.palette[1],
              '--palette-c': fingerprint.palette[2],
              '--palette-d': fingerprint.palette[3] || fingerprint.palette[0],
            }}
          >
            <i/>
            <b>{pattern.label}</b>
          </span>
        );
      })}
      {sections.length > visibleSections.length && (
        <span className="lw-compound-thumb-more">+{sections.length - visibleSections.length}</span>
      )}
    </span>
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

function makeVisibleRecoveryLook(look = {}) {
  const normalized = normalizeSectionVisualLook(look);
  return {
    ...normalized,
    brightness: Math.max(normalized.brightness || 0, RECOVERY_MIN_BRIGHTNESS),
    blackout: false,
  };
}

function runtimePackageLedPixels(runtimePackage = {}) {
  const config = runtimePackage.config || runtimePackage;
  const value = Number(config?.led?.pixels);
  return Number.isFinite(value) ? value : 0;
}

function shouldBlockDefaultLayoutOverwrite({ strips = [], runtimePackage = {}, cardStatus = null } = {}) {
  const localPixels = runtimePackageLedPixels(runtimePackage);
  const cardPixels = Number(cardStatus?.led?.pixels);
  if (!Number.isFinite(cardPixels) || cardPixels <= 0 || localPixels <= 0) return false;
  return isDefaultCircleLayout(strips) &&
    localPixels <= DEFAULT_CIRCLE_TOTAL_PIXELS &&
    cardPixels >= Math.max(DEFAULT_LAYOUT_OVERWRITE_MIN_PIXELS, localPixels * 2);
}

function downsamplePreviewPixels(pixels = [], budget = PATTERN_PREVIEW_MAX_POINTS) {
  if (!Array.isArray(pixels) || pixels.length <= budget) return pixels || [];
  const count = Math.max(1, Math.floor(budget));
  if (count <= 1) return [pixels[0]].filter(Boolean);
  const step = (pixels.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, index) => pixels[Math.min(pixels.length - 1, Math.round(index * step))]);
}

function downsamplePreviewStrips(strips = [], maxPoints = PATTERN_PREVIEW_MAX_POINTS) {
  const total = strips.reduce((sum, strip) => sum + (Array.isArray(strip.pixels) ? strip.pixels.length : 0), 0);
  if (total <= maxPoints) return strips;
  let used = 0;
  return strips.map((strip, index) => {
    const pixels = Array.isArray(strip.pixels) ? strip.pixels : [];
    if (!pixels.length) return strip;
    const remaining = Math.max(1, maxPoints - used);
    const proportionalBudget = Math.floor((pixels.length / total) * maxPoints);
    const budget = index === strips.length - 1
      ? remaining
      : Math.max(1, Math.min(pixels.length, proportionalBudget));
    used += Math.min(pixels.length, budget);
    return {
      ...strip,
      pixels: downsamplePreviewPixels(pixels, budget),
    };
  });
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

function targetRangeLabel(target = {}) {
  const count = Math.max(0, Math.floor(Number(target.pixelCount) || 0));
  if (!count) return 'LED -';
  if (target.kind === 'all') return count === 1 ? 'LED 1' : `LED 1-${count}`;
  const start = Math.max(1, Math.floor(Number(target.start) || 0) + 1);
  const end = Math.max(start, Math.floor(Number(target.end) || (start - 1)) + 1);
  return start === end ? `LED ${start}` : `LED ${start}-${end}`;
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

function compoundSectionsForLook(look = {}, targets = []) {
  const targetById = new Map((targets || []).map(target => [target.id, target]));
  const sections = Object.entries(look.sectionLooks || {}).map(([targetId, sectionLook]) => {
    const target = targetById.get(targetId);
    return {
      id: targetId,
      label: target?.label || titleFromId(targetId),
      look: normalizeSectionVisualLook(sectionLook),
    };
  });
  if (sections.length) return sections;
  return [{
    id: ALL_SECTIONS_TARGET_ID,
    label: 'All sections',
    look: normalizeSectionVisualLook(look.defaultLook || {}),
  }];
}

function compoundSearchText(look = {}, targets = []) {
  const sections = compoundSectionsForLook(look, targets);
  return [
    look.id,
    look.label,
    'compound pattern',
    ...sections.flatMap(section => [
      section.label,
      section.look?.patternId,
      patternLabel(section.look?.patternId),
    ]),
  ].filter(Boolean).join(' ').toLowerCase();
}

function patternMatchesCategory(pattern, categoryId) {
  const category = PATTERN_CATEGORIES.find(item => item.id === categoryId) || PATTERN_CATEGORIES[0];
  if (category.compoundOnly) return false;
  return !category.ids || category.ids.includes(pattern.id) || category.ids.includes(getCardPatternRuntimeId(pattern));
}

function readInitialEditPatternId() {
  if (typeof window === 'undefined') return '';
  try {
    const search = new URLSearchParams(window.location.search || '');
    const hash = String(window.location.hash || '').replace(/^#/, '');
    const hashParams = new URLSearchParams(hash);
    const requested = (
      search.get('editPattern') ||
      search.get('pattern') ||
      hashParams.get('editPattern') ||
      hashParams.get('pattern') ||
      ''
    ).trim().toLowerCase();
    return getCardPatternById(requested) ? requested : '';
  } catch {
    return '';
  }
}

function readInitialEditLookId() {
  if (typeof window === 'undefined') return '';
  try {
    const search = new URLSearchParams(window.location.search || '');
    const hash = String(window.location.hash || '').replace(/^#/, '');
    const hashParams = new URLSearchParams(hash);
    return (
      search.get('editLook') ||
      search.get('look') ||
      hashParams.get('editLook') ||
      hashParams.get('look') ||
      ''
    ).trim().toLowerCase();
  } catch {
    return '';
  }
}

function readInitialCardHost() {
  const storedHost = readStoredCardHost();
  if (typeof window === 'undefined') return storedHost;
  try {
    const search = new URLSearchParams(window.location.search || '');
    return normalizeCardHost(search.get('cardHost') || search.get('host') || storedHost);
  } catch {
    return storedHost;
  }
}

function LookCard({
  pattern,
  look,
  previewing,
  saved,
  inPlaylist,
  livePreviewAvailable,
  onSelect,
  onPlaylistChange,
  onDragStart,
}) {
  const fingerprint = getCardPatternFingerprint(pattern.id);
  const summary = previewing
    ? saved ? 'Previewing and saved here' : livePreviewAvailable ? 'Previewing on LEDs' : 'Previewing in Studio'
    : saved ? 'Saved for this target' : pattern.description || 'Tap to preview this look';
  return (
    <article
      className={`lw-look-card ${saved ? 'is-selected' : ''} ${previewing ? 'is-previewing' : ''}`}
      draggable
      onDragStart={event => onDragStart?.(pattern, event)}
    >
      <button
        type="button"
        className="lw-look-card-main"
        data-pattern-id={pattern.id}
        draggable={false}
        aria-label={`${pattern.label}. ${summary}`}
        onClick={onSelect}
      >
        <PatternThumbnail pattern={pattern} fingerprint={fingerprint}/>
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

function CompoundPatternCard({
  look,
  targets,
  active,
  inPlaylist,
  onSelect,
  onPlaylistChange,
}) {
  const sections = compoundSectionsForLook(look, targets);
  const sectionCount = sections.length;
  const sectionSummary = sections
    .slice(0, 3)
    .map(section => `${section.label}: ${patternLabel(section.look?.patternId)}`)
    .join(' / ');
  return (
    <article className={`lw-look-card is-compound ${active ? 'is-selected' : ''}`}>
      <button
        type="button"
        className="lw-look-card-main"
        data-look-id={look.id}
        aria-label={`${look.label}. Compound pattern with ${sectionCount} section${sectionCount === 1 ? '' : 's'}.`}
        onClick={onSelect}
      >
        <CompoundThumbnail look={look} targets={targets}/>
        <span className="lw-look-card-copy">
          <strong>{look.label}</strong>
          <span>Compound pattern</span>
          <span className="lw-compound-card-meta">
            {sectionCount} section{sectionCount === 1 ? '' : 's'}{sectionSummary ? ` / ${sectionSummary}` : ''}
          </span>
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
  onPatternDrop,
}) {
  const pattern = getCardPatternById(target.look?.patternId);
  const fingerprint = getCardPatternFingerprint(pattern?.id || target.look?.patternId || 'aurora');
  const readOnlyName = target.kind === 'all';
  const onInputClick = event => event.stopPropagation();
  const readDraggedPatternId = event => (
    event.dataTransfer?.getData('application/x-lightweaver-pattern') ||
    event.dataTransfer?.getData('text/plain') ||
    ''
  ).trim().toLowerCase();
  return (
    <div
      role="button"
      tabIndex={0}
      className={`lw-section-target is-${target.kind} ${active ? 'is-active' : ''}`}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onDragOver={event => {
        if (!onPatternDrop) return;
        const transferTypes = Array.from(event.dataTransfer?.types || []);
        if (!transferTypes.includes('application/x-lightweaver-pattern')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={event => {
        const patternId = readDraggedPatternId(event);
        if (!patternId || !getCardPatternById(patternId)) return;
        event.preventDefault();
        onPatternDrop(target, patternId);
      }}
      data-testid={`section-target-${target.id}`}
    >
      <span className="lw-section-target-main">
        <label className="lw-target-edit-field lw-target-name-field">
          <span>{readOnlyName ? 'Target' : 'Name'}</span>
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
        </label>
        <label className="lw-target-edit-field lw-target-led-field">
          <span>{target.kind === 'all' ? 'Total LEDs' : 'LEDs'}</span>
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
        </label>
        <span
          className="lw-section-target-range"
          data-testid={`section-target-range-${target.id}`}
        >
          {targetRangeLabel(target)}
        </span>
      </span>
      <span className="lw-section-target-look">
        {pattern && <PatternThumbnail pattern={pattern} fingerprint={fingerprint}/>}
        <span className="lw-section-target-look-copy">
          <span>Pattern</span>
          <b>{pattern?.label || target.look?.patternId || 'Pattern'}</b>
        </span>
      </span>
    </div>
  );
}

export function PatternsScreen() {
  const {
    projectName,
    projectRevision,
    strips,
    setStrips,
    viewBox,
    setViewBox,
    svgText,
    patchBoard,
    setPatchBoard,
    standaloneController,
    setStandaloneController,
    registerProjectSnapshotContributor,
    symSettings,
    setSymSettings,
  } = useProject();
  const [cardHost, setCardHost] = useState(readInitialCardHost);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');
  const [handoffUrl, setHandoffUrl] = useState('');
  const [livePreviewEnabled, setLivePreviewEnabled] = useState(true);
  const [selectedTargetId, setSelectedTargetId] = useState(ALL_SECTIONS_TARGET_ID);
  const [draftLooks, setDraftLooks] = useState({});
  const [lookLabel, setLookLabel] = useState('');
  const [patternSearch, setPatternSearch] = useState('');
  const [patternCategory, setPatternCategory] = useState('all');
  const [visiblePatternLimit, setVisiblePatternLimit] = useState(INITIAL_PATTERN_VISIBLE_COUNT);
  const [localChipDefault, setLocalChipDefault] = useState(readLocalChipDefault);
  const [recoveringLights, setRecoveringLights] = useState(false);
  const [repairLedPrompt, setRepairLedPrompt] = useState(null);
  const [stripColorTestPattern, setStripColorTestPattern] = useState('test-red');
  const livePreviewTimer = useRef(null);
  const livePreviewSeq = useRef(0);
  const draftProjectSnapshotRef = useRef(project => project);
  const bridgeAutoPreviewDone = useRef(false);
  const initialEditPatternId = useRef(readInitialEditPatternId());
  const initialEditLookId = useRef(readInitialEditLookId());
  const livePreviewAvailable = true;
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
  const stripColorOrder = normalizeUsbLedColorOrder(standaloneController?.led?.colorOrder || 'RGB');
  const rawPlaylist = isImplicitDefaultPatternPlaylist(standaloneController?.playlist)
    ? []
    : standaloneController?.playlist;
  const playlist = normalizeCardPlaylist(rawPlaylist, {
    savedLooks,
    allowEmpty: true,
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
  const patternSearchQuery = patternSearch.trim().toLowerCase();
  const patternSearchActive = patternSearchQuery.length > 0;
  const compoundPatternItems = useMemo(() => (
    savedLooks.map(savedLook => ({ kind: 'compound', id: `compound-${savedLook.id}`, look: savedLook }))
  ), [savedLooks]);
  const patternBankItems = useMemo(() => (
    DEFAULT_CARD_PATTERN_BANK.map(pattern => ({ kind: 'pattern', id: pattern.id, pattern }))
  ), []);
  const filteredCompoundPatternItems = useMemo(() => {
    const category = PATTERN_CATEGORIES.find(item => item.id === patternCategory) || PATTERN_CATEGORIES[0];
    if (category.id !== 'all' && !category.compoundOnly) return [];
    return compoundPatternItems.filter(item => (
      !patternSearchQuery || compoundSearchText(item.look, sectionTargets).includes(patternSearchQuery)
    ));
  }, [compoundPatternItems, patternCategory, patternSearchQuery, sectionTargets]);
  const filteredPatternItems = useMemo(() => {
    const category = PATTERN_CATEGORIES.find(item => item.id === patternCategory) || PATTERN_CATEGORIES[0];
    if (category.compoundOnly) return [];
    return patternBankItems.filter(item => {
      const pattern = item.pattern;
      if (!patternMatchesCategory(pattern, patternCategory)) return false;
      if (!patternSearchQuery) return true;
      const searchable = `${pattern.label} ${pattern.description || ''} ${pattern.id} ${getCardPatternRuntimeId(pattern)}`.toLowerCase();
      return searchable.includes(patternSearchQuery);
    });
  }, [patternBankItems, patternCategory, patternSearchQuery]);
  const visiblePatternMatches = patternSearchActive
    ? filteredPatternItems
    : filteredPatternItems.slice(0, visiblePatternLimit);
  const visiblePatternItems = [
    ...filteredCompoundPatternItems,
    ...visiblePatternMatches,
  ];
  const hiddenPatternCount = Math.max(0, filteredPatternItems.length - visiblePatternMatches.length);
  const nextPatternLoadCount = Math.min(PATTERN_LOAD_BATCH_SIZE, hiddenPatternCount);
  const shownPatternCount = visiblePatternMatches.length;

  useEffect(() => {
    setVisiblePatternLimit(INITIAL_PATTERN_VISIBLE_COUNT);
  }, [patternCategory, patternSearchQuery]);

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
    const sourcePreviewStrips = (strips || []).map(strip => {
      const stripTarget = effectiveSectionTargets.find(target => target.kind === 'section' && target.stripId === strip.id);
      const targetLook = selectedTarget?.kind === 'section' && selectedTarget?.stripId === strip.id
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
    return downsamplePreviewStrips(sourcePreviewStrips);
  }, [draftDefaultLook, effectiveSectionTargets, look, selectedTarget, strips]);

  useEffect(() => {
    if (sectionTargets.some(target => target.id === selectedTargetId)) return;
    setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
  }, [sectionTargets, selectedTargetId]);

  useEffect(() => {
    setDraftLooks({});
    setLookLabel('');
    setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
  }, [projectRevision]);

  const updateController = (patch) => {
    setStandaloneController(prev => {
      const current = prev || {};
      return {
        ...current,
        ...patch,
        led: patch.led
          ? { ...(current.led || {}), ...patch.led }
          : current.led,
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

  const playStripColorTest = async (patternId = stripColorTestPattern, colorOrder = stripColorOrder) => {
    const test = STRIP_COLOR_TESTS.find(item => item.id === patternId) || STRIP_COLOR_TESTS[0];
    setStripColorTestPattern(test.id);
    setStatusKind('');
    setStatus(`Showing ${test.label} test on ${cardHostToUrl(cardHost)} with ${colorOrder} order...`);
    try {
      await recoverCardLights({
        patternId: test.id,
        brightness: test.brightness,
        syncZones: true,
      }, { host: cardHost, timeoutMs: 3200 });
      setStatusKind('ok');
      setStatus(`${test.label} test is live. If the strip is not ${test.label.toLowerCase()}, press Try next order.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.message || `${test.label} test could not reach ${cardHostToUrl(cardHost)}.`);
    }
  };

  const applyStripColorOrder = async (order) => {
    const nextOrder = normalizeUsbLedColorOrder(order, stripColorOrder);
    updateController({ led: { colorOrder: nextOrder } });
    setStatusKind('');
    setStatus(`Trying ${nextOrder} color order on ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await pushLiveHardwareToCard({ colorOrder: nextOrder }, { host: cardHost, timeoutMs: 2200 });
      const appliedOrder = normalizeUsbLedColorOrder(response?.colorOrder || nextOrder, nextOrder);
      if (appliedOrder !== nextOrder) updateController({ led: { colorOrder: appliedOrder } });
      await playStripColorTest(stripColorTestPattern, appliedOrder);
      setStatusKind('ok');
      const test = STRIP_COLOR_TESTS.find(item => item.id === stripColorTestPattern) || STRIP_COLOR_TESTS[0];
      setStatus(`${appliedOrder} order is live. ${test.label} was sent again; stop when the strip shows ${test.label.toLowerCase()}.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.message || `${nextOrder} color order could not reach ${cardHostToUrl(cardHost)}.`);
    }
  };

  const tryNextStripColorOrder = () => {
    const currentIndex = COLOR_ORDERS.indexOf(stripColorOrder);
    const nextOrder = COLOR_ORDERS[((currentIndex >= 0 ? currentIndex : 0) + 1) % COLOR_ORDERS.length];
    void applyStripColorOrder(nextOrder);
  };

  const scheduleLivePreview = useCallback((nextLook, target = selectedTarget) => {
    if (!livePreviewEnabled) return;
    setHandoffUrl('');
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const zone = target?.kind === 'section' ? target.zoneId || target.id : '';
    livePreviewTimer.current = setTimeout(async () => {
      setHandoffUrl('');
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
            ? error.message
            : `Could not preview on the card at ${cardHostToUrl(cardHost)}.`);
        }
      }
    }, 80);
  }, [cardHost, livePreviewAvailable, livePreviewEnabled, selectedTarget]);

  useEffect(() => () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
  }, []);

  useEffect(() => {
    if (!cardBridgeAutoPreviewEnabled()) return undefined;
    bootstrapCardBridgeFromOpener();

    const previewFromBridge = async (state = getCardBridgeState()) => {
      if (bridgeAutoPreviewDone.current || (!state?.connected && !state?.open)) return;
      bridgeAutoPreviewDone.current = true;
      const host = state.host || cardHost;
      if (host) {
        setCardHost(host);
        writeStoredCardHost(host);
      }
      setHandoffUrl('');
      setStatusKind('');
      setStatus(`Studio connected to ${cardHostToUrl(host || cardHost)}. Taking over the LEDs...`);
      try {
        const response = await pushSectionPreviewToCard(effectiveSectionTargets, {
          host: host || cardHost,
          timeoutMs: 2600,
        });
        setStatusKind('ok');
        setStatus(response?.previewZoneFallback
          ? 'Studio is controlling the whole card. Save Settings to the card once to restore separate section preview.'
          : 'Studio is controlling the card now. Pattern and combo changes preview live until you save them.');
      } catch (error) {
        bridgeAutoPreviewDone.current = false;
        setStatusKind('err');
        setStatus(error?.message || `Studio opened, but could not take over the LEDs at ${cardHostToUrl(host || cardHost)}.`);
      }
    };

    previewFromBridge();
    const onBridgeChange = (event) => previewFromBridge(event.detail || getCardBridgeState());
    window.addEventListener?.(CARD_BRIDGE_CHANGED_EVENT, onBridgeChange);
    return () => window.removeEventListener?.(CARD_BRIDGE_CHANGED_EVENT, onBridgeChange);
  }, [cardHost, effectiveSectionTargets]);

  const updatePreviewLook = (patch, { push = true } = {}) => {
    if (!selectedTarget) return;
    const nextLook = normalizeSectionVisualLook({ ...look, ...patch });
    setDraftLooks(prev => ({ ...prev, [selectedTarget.id]: nextLook }));
    if (push) scheduleLivePreview(nextLook, selectedTarget);
  };

  useEffect(() => {
    const patternId = initialEditPatternId.current;
    if (!patternId || !selectedTarget) return;
    const pattern = getCardPatternById(patternId);
    initialEditPatternId.current = '';
    if (!pattern) return;
    const target = sectionTargets.find(item => item.id === ALL_SECTIONS_TARGET_ID) || selectedTarget;
    const baseLook = target.id === ALL_SECTIONS_TARGET_ID ? draftDefaultLook : resolveDraftTargetLook(target);
    const nextLook = normalizeSectionVisualLook({ ...baseLook, patternId });
    setSelectedTargetId(target.id);
    setDraftLooks(prev => ({ ...prev, [target.id]: nextLook }));
    setStatusKind('');
    setStatus(`Editing ${pattern.label} from the local card. Tune it here, then save it to the card or add it to the playlist.`);
    scheduleLivePreview(nextLook, target);
  }, [draftDefaultLook, resolveDraftTargetLook, scheduleLivePreview, sectionTargets, selectedTarget]);

  const beginPatternDrag = (pattern, event) => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/x-lightweaver-pattern', pattern.id);
    event.dataTransfer.setData('text/plain', pattern.id);
  };

  const dropPatternOnTarget = (target, patternId) => {
    const pattern = getCardPatternById(patternId);
    if (!target || !pattern) return;
    const baseLook = resolveDraftTargetLook(target);
    const nextLook = normalizeSectionVisualLook({ ...baseLook, patternId: pattern.id });
    setSelectedTargetId(target.id);
    setDraftLooks(prev => ({ ...prev, [target.id]: nextLook }));
    scheduleLivePreview(nextLook, target);
  };

  const resetPatternDefaults = () => {
    updatePreviewLook({ ...DEFAULT_TUNING, patternId: look.patternId });
  };

  const updateGeometry = (settings) => {
    setSymSettings(prev => ({ ...(prev || {}), ...settings }));
  };

  const buildCurrentHardwareState = ({ saveNamedLook = false, label = '', uniqueLookId = false } = {}) => {
    const nextLook = normalizeSectionVisualLook(look);
    const selectedTargetDrafted = Boolean(
      selectedTarget?.id && Object.prototype.hasOwnProperty.call(draftLooks, selectedTarget.id),
    );
    const draftLookEntries = {
      ...draftLooks,
      ...(selectedTargetDrafted ? { [selectedTarget.id]: nextLook } : {}),
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

  draftProjectSnapshotRef.current = (project) => {
    if (!Object.keys(draftLooks).length) return project;
    const { nextBoard, nextController } = buildCurrentHardwareState();
    return {
      ...project,
      layout: {
        ...(project.layout || {}),
        patchBoard: nextBoard,
      },
      devices: {
        ...(project.devices || {}),
        standaloneController: nextController,
      },
    };
  };

  useEffect(() => {
    if (!registerProjectSnapshotContributor) return undefined;
    return registerProjectSnapshotContributor((project) => draftProjectSnapshotRef.current(project));
  }, [registerProjectSnapshotContributor]);

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
    setStatus(`${saved?.label || 'Compound pattern'} saved to the pattern bank.`);
  };

  const checkCardLayoutWriteSafety = async (runtimePackageForCard, actionLabel = 'saving') => {
    const localPixels = runtimePackageLedPixels(runtimePackageForCard);
    if (!isDefaultCircleLayout(strips) || localPixels > DEFAULT_CIRCLE_TOTAL_PIXELS) {
      return { ok: true, host: cardHost };
    }
    const discovered = await discoverCardStatus({
      preferredHost: cardHost,
      timeoutMs: 650,
      persist: true,
    });
    if (!discovered.connected) return { ok: true, host: cardHost };
    if (discovered.host) {
      setCardHost(discovered.host);
      writeStoredCardHost(discovered.host);
    }
    if (!shouldBlockDefaultLayoutOverwrite({
      strips,
      runtimePackage: runtimePackageForCard,
      cardStatus: discovered.status,
    })) {
      return { ok: true, host: discovered.host || cardHost };
    }
    const cardPixels = Number(discovered.status?.led?.pixels);
    setStatusKind('err');
    setStatus(`Stopped before ${actionLabel}: this project is still the default ${localPixels}-pixel layout, but the card is configured for ${cardPixels} pixels. Load the real project or set the LED counts before saving to the card.`);
    return {
      ok: false,
      host: discovered.host || cardHost,
      localPixels,
      cardPixels,
    };
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
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Applying split preview to ${cardHostToUrl(cardHost)}...`);
    try {
      const safety = await checkCardLayoutWriteSafety(nextPackage, 'applying split preview');
      if (!safety.ok || sequence !== livePreviewSeq.current) return;
      const response = await pushConfigToCard(nextPackage, {
        host: safety.host || cardHost,
        timeoutMs: 6000,
        reboot: 'if-needed',
        allowLayoutChange: true,
      });
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
      await pushLivePreviewToCard({ ...nextLook, zone }, { host: safety.host || cardHost, timeoutMs: 2200 }).catch(() => null);
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('ok');
      setStatus('Split preview is live on the card. Section taps now target Outer and Inner separately.');
    } catch (error) {
      if (sequence !== livePreviewSeq.current) return;
      if (error?.reason === 'mixed-content') {
        offerCardHandoff(nextPackage, 'The browser blocked direct local-card access from this public page. Open the card installer to apply this split on the card.');
      } else if (error?.reason === 'layout-mismatch') {
        setStatusKind('err');
        setStatus(error.message);
      } else {
        setStatusKind('err');
        setStatus(`Could not apply split preview to the card at ${cardHostToUrl(cardHost)}.`);
      }
    }
  };

  const savePreviewToCard = async () => {
    const activeSavedLook = savedLooks.find(item => item.id === activeLookId);
    if (activeSavedLook && selectedTarget?.id === ALL_SECTIONS_TARGET_ID && Object.keys(draftLooks).length === 0) {
      await loadSavedLookToCard(activeSavedLook);
      return;
    }

    const { nextLook, nextBoard, nextController: savedController } = buildCurrentHardwareState({ saveNamedLook: true });
    const nextController = promotePatternFirst(savedController, nextLook.patternId);
    const nextPackage = buildCardRuntimePackageFromProject({
      projectName,
      strips,
      patchBoard: nextBoard,
      standaloneController: nextController,
    });
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Saving ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} to ${cardHostToUrl(cardHost)}...`);
    try {
      const safety = await checkCardLayoutWriteSafety(nextPackage, 'saving');
      if (!safety.ok) return;
      setPatchBoard(nextBoard);
      setStandaloneController(nextController);
      setDraftLooks({});
      setLookLabel('');
      const response = await pushConfigToCard(nextPackage, { host: safety.host || cardHost, timeoutMs: 6000, reboot: 'if-needed' });
      if (response.rebooting) {
        setStatusKind('ok');
        setStatus('Saved on the card. The card is rebooting now so the LED output layout takes effect.');
        return;
      }
      const zone = selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '';
      await pushLivePreviewToCard({ ...nextLook, zone }, { host: safety.host || cardHost, timeoutMs: 2200 }).catch(() => null);
      setStatusKind('ok');
      setStatus('Saved on the card. This is now the startup look and playlist config.');
    } catch (error) {
      if (error?.reason === 'mixed-content') {
        offerCardHandoff(nextPackage, 'Saved in Studio. The browser blocked direct local-card access, so open the card installer to finish saving it on the card.');
      } else if (error?.reason === 'layout-mismatch') {
        setStatusKind('err');
        setStatus(error.message);
      } else {
        setStatusKind('err');
        setStatus('Saved in the Studio, but could not reach the card. Copy or download the setup JSON and paste it on the card page.');
      }
    }
  };

  const resolveRepairHost = async () => {
    if (/^\d+\.\d+\.\d+\.\d+(?::\d+)?$/.test(normalizeCardHost(cardHost))) return cardHost;
    const discovered = await discoverCardStatus({
      preferredHost: cardHost,
      timeoutMs: 650,
      persist: true,
    });
    if (discovered.connected && discovered.host) {
      setCardHost(discovered.host);
      writeStoredCardHost(discovered.host);
      return discovered.host;
    }
    return cardHost;
  };

  const repairLedFixed = () => {
    setRepairLedPrompt(null);
    setRecoveringLights(false);
    setStatusKind('ok');
    setStatus('LED repair stopped. Lights are responding.');
  };

  const repairLedPhysicalChecks = () => {
    setRepairLedPrompt(null);
    setRecoveringLights(false);
    setStatusKind('err');
    setStatus('Step 5: The card is alive and outputting white on mirrored pins. Check strip 5V, strip GND, card GND tied to strip GND, data into DIN, and data wire on GPIO 16, 17, 18, 21, 38, 39, 40, or 48.');
  };

  const startRepairLed = async () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const recoveryLabel = targetLabel(selectedTarget || sectionTargets[0]);
    setHandoffUrl('');
    setRepairLedPrompt(null);
    setStatusKind('');
    setRecoveringLights(true);
    setStatus(`Step 1: Pulling control to ${recoveryLabel}...`);
    try {
      const repairHost = await resolveRepairHost();
      if (sequence !== livePreviewSeq.current) return;
      const details = await recoverCardLights({
        patternId: 'warm-white',
        brightness: 1,
        syncZones: true,
      }, {
        host: repairHost,
        timeoutMs: 3200,
        autoDiscover: false,
      });
      if (sequence !== livePreviewSeq.current) return;
      const brightnessByte = Number(details?.diagnostics?.brightnessByte);
      const diagnosticText = Number.isFinite(brightnessByte) ? ` Brightness ${brightnessByte}/255.` : '';
      setStatusKind('ok');
      setStatus(`Step 1: Warm white recovery sent to ${cardHostToUrl(repairHost)}.${diagnosticText} Do you see light?`);
      setRepairLedPrompt({ next: 'white', host: repairHost });
    } catch (error) {
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('err');
      setStatus(error?.message || `Step 1 could not reach ${cardHostToUrl(cardHost)}. Check power and WiFi, then turn on Use local card.`);
    } finally {
      if (sequence === livePreviewSeq.current) setRecoveringLights(false);
    }
  };

  const repairLedWhiteTest = async () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const repairHost = repairLedPrompt?.host || cardHost;
    setHandoffUrl('');
    setStatusKind('');
    setRecoveringLights(true);
    setStatus('Step 2: Sending identify blink and full white test...');
    try {
      await identifyCardLights({ host: repairHost, timeoutMs: 1400, autoDiscover: false }).catch(() => null);
      const details = await recoverCardLights({
        patternId: 'test-white',
        brightness: 1,
        syncZones: true,
      }, {
        host: repairHost,
        timeoutMs: 3200,
        autoDiscover: false,
      });
      if (sequence !== livePreviewSeq.current) return;
      const pixel = details?.diagnostics?.firstPhysicalPixel;
      const pixelText = pixel ? ` First pixel ${pixel.r},${pixel.g},${pixel.b}.` : '';
      setStatusKind('ok');
      setStatus(`Step 2: White test sent.${pixelText} Do you see white light or a blink?`);
      setRepairLedPrompt({ next: 'mirror', host: repairHost });
    } catch (error) {
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('err');
      setStatus(error?.message || `Step 2 could not reach ${cardHostToUrl(repairHost)}.`);
    } finally {
      if (sequence === livePreviewSeq.current) setRecoveringLights(false);
    }
  };

  const repairLedMirroredOutput = async () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const repairHost = repairLedPrompt?.host || cardHost;
    const { nextBoard, nextController } = buildCurrentHardwareState();
    const nextPackage = buildCardRuntimePackageFromProject({
      projectName,
      strips,
      patchBoard: nextBoard,
      standaloneController: nextController,
    });
    const repairPackage = buildMirroredLedRepairPackage(nextPackage, { projectName });
    const repairOutput = repairPackage.config.led.outputs[0];
    setHandoffUrl('');
    setStatusKind('');
    setRecoveringLights(true);
    setStatus('Step 3: Saving safe mirrored LED output and rebooting the card...');
    try {
      const response = await repairMirroredLedOutputOnCard(nextPackage, {
        host: repairHost,
        timeoutMs: 6000,
        projectName,
      });
      if (sequence !== livePreviewSeq.current) return;
      setPatchBoard(nextBoard);
      setStandaloneController({
        ...nextController,
        outputs: [repairOutput],
      });
      setDraftLooks({});
      setStatusKind('ok');
      setStatus(response.rebooting
        ? 'Step 3: Safe mirrored output saved. The card is rebooting; wait a few seconds, then test the repaired output.'
        : 'Step 3: Safe mirrored output saved. Test the repaired output now.');
      setRepairLedPrompt({ next: 'post-mirror-test', host: repairHost });
    } catch (error) {
      if (sequence !== livePreviewSeq.current) return;
      if (error?.reason === 'mixed-content') {
        offerCardHandoff(repairPackage, 'The browser blocked direct local-card access. Open the card installer to save the safe mirrored LED output.');
      } else {
        setStatusKind('err');
        setStatus(error?.message || `Step 3 could not save the safe LED output to ${cardHostToUrl(repairHost)}.`);
      }
    } finally {
      if (sequence === livePreviewSeq.current) setRecoveringLights(false);
    }
  };

  const repairLedPostMirrorTest = async () => {
    if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    const sequence = ++livePreviewSeq.current;
    const repairHost = repairLedPrompt?.host || cardHost;
    setHandoffUrl('');
    setStatusKind('');
    setRecoveringLights(true);
    setStatus('Step 4: Testing the repaired mirrored output...');
    try {
      await recoverCardLights({
        patternId: 'test-white',
        brightness: 1,
        syncZones: true,
      }, {
        host: repairHost,
        timeoutMs: 4200,
        autoDiscover: true,
      });
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('ok');
      setStatus('Step 4: White test sent after the output repair. Do you see light now?');
      setRepairLedPrompt({ next: 'checks', host: repairHost });
    } catch (error) {
      if (sequence !== livePreviewSeq.current) return;
      setStatusKind('err');
      setStatus(error?.message || `Step 4 could not reach ${cardHostToUrl(repairHost)} after reboot.`);
    } finally {
      if (sequence === livePreviewSeq.current) setRecoveringLights(false);
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

    setHandoffUrl('');
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

  useEffect(() => {
    const lookId = initialEditLookId.current;
    if (!lookId) return;
    const savedLook = savedLooks.find(item => item.id === lookId);
    initialEditLookId.current = '';
    if (!savedLook) {
      setStatusKind('err');
      setStatus('That card look is not in this Studio project yet. Open the matching project or import the card package to edit it.');
      return;
    }
    applySavedLook(savedLook);
  }, [savedLooks, applySavedLook]);

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
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Loading ${savedLook.label} to ${cardHostToUrl(cardHost)}...`);
    try {
      const safety = await checkCardLayoutWriteSafety(nextPackage, 'loading this look');
      if (!safety.ok) return;
      setPatchBoard(nextBoard);
      setStandaloneController(nextController);
      setDraftLooks({});
      setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
      const response = await pushConfigToCard(nextPackage, { host: safety.host || cardHost, timeoutMs: 6000, reboot: 'if-needed' });
      setStatusKind('ok');
      setStatus(response.rebooting
        ? `${savedLook.label} loaded. The card is rebooting so the LED layout takes effect.`
        : `${savedLook.label} loaded on the card.`);
    } catch (error) {
      if (error?.reason === 'mixed-content') {
        offerCardHandoff(nextPackage, 'The browser blocked direct local-card access from this public page. Open the card installer to load this combo on the card.');
      } else if (error?.reason === 'layout-mismatch') {
        setStatusKind('err');
        setStatus(error.message);
      } else {
        setStatusKind('err');
        setStatus(`Could not load ${savedLook.label} to the card at ${cardHostToUrl(cardHost)}.`);
      }
    }
  };

  const writePlaylist = (nextItems, message = '') => {
    const normalized = normalizeCardPlaylist(nextItems, {
      savedLooks,
      allowEmpty: true,
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

  const setSavedLookInPlaylist = (savedLook, enabled) => {
    const next = enabled
      ? playlistContainsCombo(playlist, savedLook.id)
        ? playlist
        : [...playlist, makeComboPlaylistItem(savedLook)].filter(Boolean)
      : playlist.filter(item => !(item.type === 'combo' && item.lookId === savedLook.id));
    writePlaylist(next, enabled
      ? `${savedLook.label} added to the Playlist.`
      : `${savedLook.label} removed from the Playlist.`);
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

  const offerCardHandoff = (runtimePackageForCard, message) => {
    setHandoffUrl(buildCardConfigHandoffUrl(cardHost, runtimePackageForCard));
    setStatusKind('err');
    setStatus(message);
  };

  const copyConfig = async () => {
    setHandoffUrl('');
    try {
      await navigator.clipboard.writeText(configJson);
      setStatusKind('ok');
      setStatus('Setup JSON copied. Paste it into the card page on the same WiFi.');
    } catch {
      setStatusKind('err');
      setStatus('Clipboard was blocked. Download the setup JSON instead.');
    }
  };

  const beginCardBridgeHandoff = ({ localDefault = false } = {}) => {
    setHandoffUrl('');
    const opened = openCardBridge(cardHost, {
      autoOpenStudio: true,
      studioUrl: typeof window !== 'undefined' ? window.location.href : '',
    });
    if (opened) {
      setStatusKind('');
      setStatus(localDefault
        ? `Local card is now the default control path. Opening ${cardHostToUrl(cardHost)} so Studio can take over the LEDs there.`
        : `Opening the local card bridge at ${cardHostToUrl(cardHost)}. Studio will take over the LEDs when it loads there.`);
      return;
    }
    setStatusKind('err');
    setStatus(`Could not open ${cardHostToUrl(cardHost)}. Allow popups or open the card from the bottom-left Card status.`);
  };

  const toggleLocalChipDefault = () => {
    const next = !localChipDefault;
    writeLocalChipDefault(next);
    setLocalChipDefault(next);
    if (next) {
      beginCardBridgeHandoff({ localDefault: true });
      return;
    }
    setStatusKind('ok');
    setStatus('Local card is off. Studio will use direct local access when the browser allows it.');
  };

  return (
    <div className="lw-patterns-screen">
      <div className="lw-patterns-shell">
        <header className="lw-patterns-hero">
          <div>
            <h1>Patterns & Compounds</h1>
            <p>Choose chip-ready patterns, tune the colors, then save section blends as compound patterns for the card.</p>
          </div>
          <div className="lw-patterns-actions" aria-label="Card controls">
            <div className="lw-action-group lw-action-group-main" aria-label="Card actions">
              <span className="lw-action-group-label">Card</span>
              <button type="button" className="btn btn-primary lw-toolbar-primary" onClick={savePreviewToCard}>Save to card</button>
              <button type="button" className="btn btn-ghost lw-toolbar-action lw-recover-lights-btn" onClick={startRepairLed} disabled={recoveringLights}>
                {recoveringLights ? 'Repairing...' : 'Repair LED'}
              </button>
            </div>
            <div className="lw-action-group" aria-label="Section layout">
              <span className="lw-action-group-label">Section</span>
              <button type="button" className="btn btn-ghost lw-toolbar-action" onClick={applySplitPreviewToCard}>Send split preview</button>
            </div>
            <div className="lw-action-group" aria-label="Card connection">
              <span className="lw-action-group-label">Connection</span>
              <button
                type="button"
                className={`btn btn-ghost lw-toolbar-action ${localChipDefault ? 'is-active' : ''}`}
                aria-pressed={localChipDefault}
                onClick={toggleLocalChipDefault}
              >
                {localChipDefault ? 'Using local card' : 'Use local card'}
              </button>
              <button type="button" className="btn btn-ghost lw-toolbar-action" onClick={() => window.open(cardHostToUrl(cardHost), '_blank')}>Open card page</button>
            </div>
            <div className="lw-action-group" aria-label="Manual setup">
              <span className="lw-action-group-label">Setup</span>
              <button type="button" className="btn btn-ghost lw-toolbar-action" onClick={copyConfig}>Copy setup</button>
              <button type="button" className="btn btn-ghost lw-toolbar-action" onClick={() => downloadJson(`${safeProjectName || 'lightweaver'}-chip-config.json`, configJson)}>Download setup</button>
            </div>
          </div>
        </header>

        {status && (
          <div className={`lw-chip-status ${statusKind === 'ok' ? 'is-ok' : statusKind === 'err' ? 'is-err' : ''}`}>
            {status}
            {repairLedPrompt && (
              <div className="lw-repair-actions" aria-label="LED repair response">
                {repairLedPrompt.next !== 'post-mirror-test' && (
                  <button type="button" className="btn btn-primary" onClick={repairLedFixed} disabled={recoveringLights}>
                    Yes, fixed
                  </button>
                )}
                {repairLedPrompt.next === 'white' && (
                  <button type="button" className="btn btn-ghost" onClick={repairLedWhiteTest} disabled={recoveringLights}>
                    No, try white test
                  </button>
                )}
                {repairLedPrompt.next === 'mirror' && (
                  <button type="button" className="btn btn-ghost" onClick={repairLedMirroredOutput} disabled={recoveringLights}>
                    No, repair output
                  </button>
                )}
                {repairLedPrompt.next === 'post-mirror-test' && (
                  <button type="button" className="btn btn-primary" onClick={repairLedPostMirrorTest} disabled={recoveringLights}>
                    Test repaired output
                  </button>
                )}
                {repairLedPrompt.next === 'checks' && (
                  <button type="button" className="btn btn-ghost" onClick={repairLedPhysicalChecks} disabled={recoveringLights}>
                    No, show checks
                  </button>
                )}
              </div>
            )}
            {handoffUrl && (
              <a className="btn btn-primary" href={handoffUrl} target="_blank" rel="noopener noreferrer">
                Open card installer
              </a>
            )}
          </div>
        )}

        <div className="lw-patterns-grid">
          <section className="lw-look-picker">
            <div className="lw-sec-header">
              <span>Tap a pattern to preview</span>
              <span className="meta">
                {shownPatternCount} shown of {DEFAULT_CARD_PATTERN_BANK.length} chip-ready
                {savedLooks.length ? ` + ${savedLooks.length} compound${savedLooks.length === 1 ? '' : 's'}` : ''}
                {' / '}
                {playlist.length} in playlist
              </span>
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
            <div className="lw-strip-color-test" aria-label="Strip color test">
              <span className="lw-strip-color-title">Strip finder</span>
              <span className="lw-strip-color-buttons" aria-label="Color test">
                {STRIP_COLOR_TESTS.map(test => (
                  <button
                    key={test.id}
                    type="button"
                    className={`btn btn-ghost ${stripColorTestPattern === test.id ? 'active' : ''}`}
                    aria-label={`Test ${test.label.toLowerCase()}`}
                    onClick={() => playStripColorTest(test.id)}
                  >
                    {test.shortLabel}
                  </button>
                ))}
              </span>
              <span className="lw-strip-order-pill">
                Order <b data-testid="strip-color-order">{stripColorOrder}</b>
              </span>
              <button
                type="button"
                className="btn btn-ghost lw-strip-next-order"
                aria-label="Try next color order"
                onClick={tryNextStripColorOrder}
              >
                Try next order
              </button>
            </div>
            <div className="lw-target-panel">
              <div className="lw-sec-header">
                <span>Design target</span>
                <span className="meta">{Math.max(0, sectionTargets.length - 1)} sections · card limit {CARD_RUNTIME_MAX_ZONES}</span>
              </div>
              <div className="lw-target-compound-bar">
                <div className="lw-target-compound-copy">
                  <span>Compound pattern</span>
                  <strong>{lookLabel.trim() || currentComboLabel}</strong>
                </div>
                <input
                  className="lw-search-input"
                  value={lookLabel}
                  onChange={event => setLookLabel(event.target.value)}
                  placeholder="Name compound pattern (optional)"
                  aria-label="Compound pattern name"
                />
                <button type="button" className="btn btn-primary" data-testid="save-current-combo" onClick={saveComboOnly}>Save compound</button>
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
                    onPatternDrop={dropPatternOnTarget}
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
              <span>{shownPatternCount} of {filteredPatternItems.length} shown</span>
            </div>
            <div className="lw-look-grid" data-preview-mode="compact">
              {visiblePatternItems.map(item => item.kind === 'compound' ? (
                <CompoundPatternCard
                  key={item.id}
                  look={item.look}
                  targets={sectionTargets}
                  active={item.look.id === activeLookId}
                  inPlaylist={playlistContainsCombo(playlist, item.look.id)}
                  onSelect={() => applySavedLook(item.look)}
                  onPlaylistChange={enabled => setSavedLookInPlaylist(item.look, enabled)}
                />
              ) : (
                <LookCard
                  key={item.id}
                  pattern={item.pattern}
                  look={look}
                  previewing={look.patternId === item.pattern.id}
                  saved={savedTargetLook.patternId === item.pattern.id}
                  inPlaylist={playlistContainsPattern(playlist, item.pattern.id)}
                  livePreviewAvailable={livePreviewAvailable}
                  onSelect={() => updatePreviewLook({ patternId: item.pattern.id })}
                  onPlaylistChange={enabled => setPatternInPlaylist(item.pattern.id, enabled)}
                  onDragStart={beginPatternDrag}
                />
              ))}
              {!visiblePatternItems.length && (
                <p className="lw-pattern-empty">No chip-ready patterns match this search.</p>
              )}
            </div>
            {hiddenPatternCount > 0 && (
              <div className="lw-pattern-load-more-row">
                <button
                  type="button"
                  className="btn btn-ghost lw-pattern-load-more"
                  data-testid="pattern-load-more"
                  onClick={() => setVisiblePatternLimit(limit => limit + PATTERN_LOAD_BATCH_SIZE)}
                >
                  Load {nextPatternLoadCount} more patterns
                </button>
                <span>{hiddenPatternCount} more in this view</span>
              </div>
            )}
          </section>

          <aside className="lw-patterns-aside">
            <Section title="Preview" meta={`${selectedTargetName} · ${selectedPattern?.label || look.patternId}`}>
              <div className="lw-pattern-led-preview" style={{ '--pattern-preview-bg': selectedPattern?.preview }}>
                <LEDPreview
                  patternId={previewPatternId}
                  playing={true}
                  speed={1}
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
                  targetFps={30}
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
                <button type="button" className="btn btn-ghost" onClick={resetPatternDefaults}>Reset pattern defaults</button>
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
