/* Light Weaver v3 — Patterns & Mixes (faithful to v3, cleaned + recolored) */
/* Exact mockup file, converted from window-global script to ES module.
   The visual body (helpers + JSX structure + class names) is the mockup's own.
   Only data + handlers are real now: the SAMPLE bank/mixes/local useState that
   drove the mockup are replaced with the live pattern bank, ProjectContext, and
   the real handlers ported from the old PatternsScreen. No visual markup, class
   names, or LED-render helpers changed. */
import React, { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { I, PATTERN_CATS, SWATCHES, GEOMETRY, JourneyHint } from './lw-shared.jsx';
import { REAL_PATTERNS, REAL_PATTERN_BY_ID, adaptPattern, adaptSavedLook, defaultWarmPatternId } from './v3-data.js';
import { useProject } from '../state/ProjectContext.jsx';
import { useCloudLibrary } from '../state/CloudLibraryContext.jsx';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import { getPatternById } from '../lib/patternRegistry.js';
import { loadCustomPatterns } from '../lib/customPatterns.js';
import { compilePattern, normalizePalette, renderPixelFrame } from '../lib/frameEngine.js';
import { applyLookColorModifiers } from '../lib/previewColorModifiers.js';
import {
  DEFAULT_CARD_VISUAL_LOOK,
  cardColorToHex,
  cardHueToDegrees,
  cardSaturationToChroma,
  hexToCardColor,
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
  derivePlaylistLookIds,
  isImplicitDefaultPatternPlaylist,
  makeComboPlaylistItem,
  makePatternPlaylistItem,
  normalizeCardPlaylist,
  playlistContainsCombo,
  playlistContainsPattern,
} from '../lib/cardPlaylist.js';
import {
  cardHostToUrl,
  discoverCardStatus,
  isLocalCardHost,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { classifyCardReadiness } from '../lib/cardReadiness.js';
import { isCardLinkPlaybackReady } from '../lib/cardConnectionFlow.js';
import { evaluateCardInstallGate, readCardAccessLevel } from '../lib/cardInstallGate.js';
import { cardProjectFingerprint } from '../lib/cardProjectResolver.js';
import {
  consumeCardEditAuthorization,
  currentCardProjectAuthorizationExpiresAt,
  hasCurrentCardProjectAuthorization,
  renewCardEditAuthorization,
} from '../lib/cardEditAuthorization.js';
import { buildCardConfigHandoffUrl, cardStorageJson, pushConfigToCard, readCardProjectEvidence } from '../lib/cardPushClient.js';
import { prepareCardStoragePayload } from '../lib/cardStoragePayload.js';
import { prepareCardDeployment, waitForCardDeploymentVerification } from '../lib/cardDeployment.js';
import { ensureCardSectionsForPreview } from '../lib/cardSectionSync.js';
import { applyTestStripToRuntimePackage, readTestStrip } from '../lib/testStrip.js';
import { pushLivePreviewToCard, recoverCardLights } from '../lib/cardLiveControl.js';
import {
  cardActionReducer,
  cardActionStatusLabel,
  classifyCardActionFailure,
  createCardActionState,
} from '../lib/cardAction.js';
import { createProjectPreviewStrip } from '../lib/previewVisuals.js';
import {
  buildPatternPreviewSegments,
  fitPreviewViewBox,
  readPatternPreviewUiState,
  writePatternPreviewUiState,
} from '../lib/patternPiecePreview.js';
import {
  CARD_BRIDGE_CHANGED_EVENT,
  acquireCardBridgeFromGesture,
  cardBridgeFeatureGap,
  getCardBridgeState,
  hasCardBridge,
  readLocalChipDefault,
  sendCardBridgeRequest,
  writeLocalChipDefault, openLocalCardPage } from '../lib/cardBridge.js';
import { computeSymmetryFit } from '../lib/symmetry.js';
import { StripColorOrderCheck } from '../components/layout/wire/StripColorOrderCheck.jsx';
import { PatternPreview } from './PatternPreview.jsx';

  // Mockup geometry id -> live symSettings.
  const GEOMETRY_SETTINGS = {
    none: { enabled: false, type: 'none' },
    mirror: { enabled: true, type: 'mirror-hv' },
    mandala: { enabled: true, type: 'radial', count: 8, twist: 0 },
    kaleido: { enabled: true, type: 'kaleido', slices: 6 },
  };
  function geometryIdFromSettings(settings = {}) {
    if (!settings?.enabled || settings.type === 'none') return 'none';
    if (String(settings.type).startsWith('mirror')) return 'mirror';
    if (settings.type === 'radial') return 'mandala';
    if (settings.type === 'kaleido') return 'kaleido';
    return 'none';
  }

  function Slider({ k, v, value, min, max, step, onChange, testId }) {
    return (
      <div className="slider-row">
        <div className="lab"><span className="k">{k}</span><span className="v" data-testid={testId ? `${testId}-readout` : undefined}>{v}</span></div>
        <input className="lw" type="range" min={min} max={max} step={step} value={value} data-testid={testId ? `${testId}-slider` : undefined} onChange={(e) => onChange(parseFloat(e.target.value))} />
      </div>);

  }

  // small glowing sine strand for the Color & motion preview
  function Strand({ tint }) {
    return (
      <svg viewBox="0 0 320 96" preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%" }}>
        <defs>
          <filter id="pm-glow" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="3.4" /></filter>
        </defs>
        <path d="M14 58 C 70 22, 110 22, 160 50 C 210 78, 250 78, 306 42" fill="none" stroke={tint} strokeWidth="6"
        strokeLinecap="round" strokeDasharray="0.1 9.2" opacity="0.9" filter="url(#pm-glow)" />
        <path d="M14 58 C 70 22, 110 22, 160 50 C 210 78, 250 78, 306 42" fill="none" stroke="oklch(0.99 0.02 90)" strokeWidth="2"
        strokeLinecap="round" strokeDasharray="0.1 9.2" />
      </svg>);

  }

  // Live version of the Color & motion strand: paints a flowing gradient sampled
  // from the REAL pattern frame, so switching patterns and tuning the sliders is
  // reflected here too. Falls back to the static strand when there's no code.
  function LiveStrand({ patternId, pal, tint, look }) {
    const gradId = useId();
    const codeId = useMemo(() => resolveCodePatternId(patternId), [patternId]);
    const fn = useMemo(() => (codeId ? compilePattern(codeId) : null), [codeId]);
    const paletteNorm = useMemo(() => normalizePalette(pal), [pal]);
    const N = 16;
    const strip = useMemo(() => buildPreviewStrip(N), []);
    const stopRefs = useRef([]);
    const live = useRef({});
    live.current = { fn, codeId, paletteNorm, strip, look };

    useEffect(() => {
      if (!fn) return undefined;
      let raf = 0;
      let start = null;
      const tick = (now) => {
        if (start === null) start = now;
        const s = live.current;
        const tMs = now - start;
        const px = applyLookColorModifiers(renderPixelFrame({
          t: tMs / 1000,
          strips: [s.strip],
          patternId: s.codeId,
          activeFn: s.fn,
          paletteNorm: s.paletteNorm,
          masterBrightness: s.look?.brightness ?? 1,
          masterSpeed: s.look?.speed ?? 1,
        }).pixels, tMs, s.look || {});
        for (let i = 0; i < N; i++) {
          const el = stopRefs.current[i];
          if (!el) continue;
          const c = px[i] || { r: 0, g: 0, b: 0 };
          el.setAttribute('stop-color', `rgb(${c.r},${c.g},${c.b})`);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [fn]);

    if (!fn) return <Strand tint={tint} />;

    return (
      <svg viewBox="0 0 320 96" preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "100%" }}>
        <defs>
          <filter id={`glow-${gradId}`} x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="3.4" /></filter>
          <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1="14" y1="0" x2="306" y2="0">
            {Array.from({ length: N }, (_, i) =>
              <stop key={i} ref={(el) => { stopRefs.current[i] = el; }} offset={`${(i / (N - 1)) * 100}%`} stopColor="#000" />
            )}
          </linearGradient>
        </defs>
        <path d="M14 58 C 70 22, 110 22, 160 50 C 210 78, 250 78, 306 42" fill="none" stroke={`url(#${gradId})`} strokeWidth="6"
        strokeLinecap="round" strokeDasharray="0.1 9.2" opacity="0.95" filter={`url(#glow-${gradId})`} />
      </svg>);

  }

  // colors interpolated across a palette → glowing LED beads
  function ledColors(pal, n) {
    const rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = (i / (n - 1)) * (pal.length - 1), s = Math.floor(p), t = p - s;
      const a = rgb(pal[s]), b = rgb(pal[Math.min(s + 1, pal.length - 1)]);
      const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
      out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    }
    return out;
  }
  function LedRow({ pal, n = 9, big = false, wave = false }) {
    return (
      <div className={"ledrow" + (big ? " big" : "")}>
        {ledColors(pal, n).map((c, i) =>
          <span key={i} className={"led" + (wave ? " wave" : "")} style={{ background: c, boxShadow: `0 0 ${big ? 9 : 5}px ${c}, 0 0 ${big ? 20 : 11}px ${c}`, animationDelay: wave ? `${i * 0.11}s` : undefined }} />
        )}
      </div>);
  }
  // Resolve a card-bank pattern id to the real library pattern that actually
  // has runnable per-pixel code. Card ids either match a library pattern
  // directly (sparkle, aurora…) or point at one via previewPatternId/preset.
  function resolveCodePatternId(patternId) {
    if (!patternId) return null;
    if (getPatternById(patternId)) return patternId;
    const card = getCardPatternById(patternId);
    const candidate = card?.previewPatternId || card?.preset;
    if (candidate && getPatternById(candidate)) return candidate;
    return null;
  }

  // Synthetic horizontal strip so the frame engine has geometry to render onto.
  function buildPreviewStrip(n) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const p = n > 1 ? i / (n - 1) : 0.5;
      pts.push({ x: p, y: 0.5, p });
    }
    return { id: 'preview', pts, brightness: 1, speed: 1 };
  }

  // The wiring compiler keeps source LEDs in canonical order and records the
  // physical direction on each compiled run. Apply that metadata only for the
  // visual preview so its bead order matches the real wire without changing
  // the runtime package consumed by the card.
  function wiringInPhysicalPreviewOrder(compiledWiring) {
    if (!compiledWiring?.pixels?.length || !compiledWiring?.runs?.length) return compiledWiring;
    const pixels = [...compiledWiring.pixels];
    for (const run of compiledWiring.runs) {
      if (!run.reversed || !Number.isInteger(run.start) || !Number.isInteger(run.count) || run.count < 2) continue;
      pixels.splice(run.start, run.count, ...pixels.slice(run.start, run.start + run.count).reverse());
    }
    return { ...compiledWiring, pixels };
  }

  // Runs the REAL compiled pattern through the frame engine on a rAF loop, applies
  // the card's exact color post-pass (hue/saturation/breathe/drift), and paints
  // each bead per frame — so Sparkle sparkles, Fire flickers, and every slider
  // recolors the preview the way the card will. Falls back to the static palette
  // strand only when a pattern has no runnable code.
  function LivePreviewRow({ patternId, pal, look, previewStrip, n = 22, big = false, symSettings }) {
    const codeId = useMemo(() => resolveCodePatternId(patternId), [patternId]);
    const fn = useMemo(() => (codeId ? compilePattern(codeId) : null), [codeId]);
    const paletteNorm = useMemo(() => normalizePalette(pal), [pal]);
    const strip = previewStrip || buildPreviewStrip(n);
    n = strip.pts.length || n;
    const beadRefs = useRef([]);
    const live = useRef({});
    live.current = { fn, codeId, paletteNorm, strip, look, n, big, symSettings };

    useEffect(() => {
      if (!fn) return undefined;
      let raf = 0;
      let start = null;
      const tick = (now) => {
        if (start === null) start = now;
        const s = live.current;
        const tMs = now - start;
        const frame = renderPixelFrame({
          t: tMs / 1000,
          strips: [s.strip],
          patternId: s.codeId,
          activeFn: s.fn,
          paletteNorm: s.paletteNorm,
          masterBrightness: s.look?.brightness ?? 1,
          masterSpeed: s.look?.speed ?? 1,
          symSettings: s.symSettings,
        });
        const px = applyLookColorModifiers(frame.pixels, tMs, s.look || {});
        const offIndexes = new Set(s.strip.offIndexes || []);
        for (let i = 0; i < s.n; i++) {
          const el = beadRefs.current[i];
          if (!el) continue;
          const c = offIndexes.has(i) ? { r: 0, g: 0, b: 0 } : (px[i] || { r: 0, g: 0, b: 0 });
          const col = `rgb(${c.r},${c.g},${c.b})`;
          el.style.background = col;
          el.style.boxShadow = `0 0 ${s.big ? 9 : 5}px ${col}, 0 0 ${s.big ? 20 : 11}px ${col}`;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }, [fn]);

    // No runnable code for this pattern → keep the old palette strand.
    if (!fn) return <LedRow pal={pal} n={n} big={big} wave />;

    return (
      <div className={"ledrow" + (big ? " big" : "")}>
        {Array.from({ length: n }, (_, i) =>
          <span key={i} ref={(el) => { beadRefs.current[i] = el; }} className="led" style={{ background: "#000" }} />
        )}
      </div>);
  }

  function LedStage({ patternId, pal, look, previewStrip, symSettings }) {
    return (
      <div className="pm-led-stage" data-testid="pattern-project-preview" data-preview-led-count={previewStrip?.pts?.length || 22} data-preview-order={(previewStrip?.order || []).join(',')} data-preview-symmetry={symSettings?.enabled ? symSettings.type : 'none'}>
        <LivePreviewRow patternId={patternId} pal={pal} look={look} previewStrip={previewStrip} n={22} big symSettings={symSettings} />
        <span className="sheen" />
      </div>);
  }

  function PatternScreen({ connected, cardLink, go }) {
    const { workspaceAssets } = useCloudLibrary();
    const {
      projectId,
      projectName,
      projectRevision,
      projectLifecycle,
      strips,
      hidden,
      setStrips,
      viewBox,
      svgText,
      patchBoard,
      compiledWiring,
      setPatchBoard,
      standaloneController,
      setStandaloneController,
      markProjectEdited,
      markProjectInstalled,
      commitProjectStateWithoutEdit,
      markCardLookConfirmed,
      symSettings,
      setSymSettings,
      bpm,
      patternParams,
      activePatternId,
      setActivePatternId,
      gammaEnabled,
      gammaValue,
      serializeProject,
    } = useProject();
    const projectPreviewStrip = useMemo(
      () => createProjectPreviewStrip({ compiledWiring: wiringInPhysicalPreviewOrder(compiledWiring), strips, hidden }),
      [projectRevision, compiledWiring, strips, hidden],
    );

    // ── browse / ui state ───────────────────────────────────────────────
    const [q, setQ] = useState("");
    const [cat, setCat] = useState("all");
    const [livePreview, setLivePreview] = useState(true);
    const [localCard, setLocalCard] = useState(readLocalChipDefault);
    const [menuOpen, setMenuOpen] = useState(false);
    const menuButtonRef = useRef(null);
    const menuRef = useRef(null);
    const [colorOrderOpen, setColorOrderOpen] = useState(false);
    const colorOrderButtonRef = useRef(null);
    const colorOrderPopoverRef = useRef(null);
    const [mixName, setMixName] = useState("");

    // Show-more pagination so the browser isn't 130+ cards tall (which buries the
    // preview on narrow screens). Resets whenever the filter or search changes.
    const PATTERN_PAGE = 24;
    const [visibleCount, setVisibleCount] = useState(PATTERN_PAGE);
    const patternSentinelRef = useRef(null);
    useEffect(() => { setVisibleCount(PATTERN_PAGE); }, [cat, q]);
    useEffect(() => {
      if (!menuOpen) return undefined;
      menuRef.current?.querySelector('button')?.focus();
      const onKeyDown = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        setMenuOpen(false);
        requestAnimationFrame(() => menuButtonRef.current?.focus());
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [menuOpen]);
    const closeColorOrder = useCallback((restoreFocus = true) => {
      setColorOrderOpen(false);
      if (restoreFocus) requestAnimationFrame(() => colorOrderButtonRef.current?.focus());
    }, []);
    useEffect(() => {
      if (!colorOrderOpen) return undefined;
      colorOrderPopoverRef.current?.querySelector('button:not(:disabled)')?.focus();
      const onKeyDown = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        closeColorOrder();
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [closeColorOrder, colorOrderOpen]);

    // ── real engine state ───────────────────────────────────────────────
    const [cardHost, setCardHost] = useState(readStoredCardHost);
    const [status, setStatus] = useState("");
    const [statusKind, setStatusKind] = useState("");
    const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
    const [cardSave, dispatchCardSave] = useReducer(cardActionReducer, undefined, createCardActionState);
    const [previewAction, dispatchPreviewAction] = useReducer(cardActionReducer, undefined, createCardActionState);
    const [previewFailure, setPreviewFailure] = useState(null);
    const [patternCardGate, setPatternCardGate] = useState('');
    const [handoffUrl, setHandoffUrl] = useState("");
    const [selectedTargetId, setSelectedTargetId] = useState(ALL_SECTIONS_TARGET_ID);
    const [draftLooks, setDraftLooks] = useState({});
    const livePreviewTimer = useRef(null);
    const livePreviewSeq = useRef(0);
    const browsePreviewSeq = useRef(0);
    const savedComboSeq = useRef(0);
    const cardReturnConsumed = useRef(false);
    const latestPreviewIntent = useRef(null);
    const syncedPreviewSelectionRef = useRef('');
    const installIntentRef = useRef(null);

    const patternAuthorizationBinding = useMemo(() => {
      const readiness = cardLink?.readiness || {};
      const card = cardLink?.card || {};
      const currentProject = serializeProject();
      return {
        cardId: readiness.cardId || card.id || card.cardId || '',
        firmwareVersion: readiness.firmwareVersion || card.firmwareVersion || '',
        buildId: readiness.buildId || card.buildId || '',
        bootId: readiness.bootId || cardLink?.validatedBootId || '',
        installedProjectId: readiness.projectId || readiness.piece?.id || '',
        installedProjectFingerprint: readiness.projectFingerprint || '',
        studioProjectId: projectId,
        studioProjectFingerprint: cardProjectFingerprint(currentProject),
        projectGeneration: projectLifecycle.generation,
      };
    }, [cardLink?.card, cardLink?.readiness, cardLink?.validatedBootId, projectId, projectLifecycle.generation, serializeProject]);
    const lastExactPatternAuthorizationBindingRef = useRef(null);
    const exactAuthorizationExpiresAt = currentCardProjectAuthorizationExpiresAt(patternAuthorizationBinding);
    if (exactAuthorizationExpiresAt > 0) {
      lastExactPatternAuthorizationBindingRef.current = patternAuthorizationBinding;
    }
    const lastExactBinding = lastExactPatternAuthorizationBindingRef.current;
    const canRetainAuthorizationDuringBridgeCheck = !cardLink?.readiness
      && lastExactBinding
      && patternAuthorizationBinding.studioProjectId === lastExactBinding.studioProjectId
      && patternAuthorizationBinding.studioProjectFingerprint === lastExactBinding.studioProjectFingerprint
      && patternAuthorizationBinding.projectGeneration === lastExactBinding.projectGeneration
      && (!patternAuthorizationBinding.cardId || patternAuthorizationBinding.cardId === lastExactBinding.cardId)
      && (!patternAuthorizationBinding.firmwareVersion || patternAuthorizationBinding.firmwareVersion === lastExactBinding.firmwareVersion)
      && (!patternAuthorizationBinding.buildId || patternAuthorizationBinding.buildId === lastExactBinding.buildId)
      && (!patternAuthorizationBinding.bootId || patternAuthorizationBinding.bootId === lastExactBinding.bootId);
    const effectivePatternAuthorizationBinding = exactAuthorizationExpiresAt > 0
      ? patternAuthorizationBinding
      : canRetainAuthorizationDuringBridgeCheck
        ? lastExactBinding
        : patternAuthorizationBinding;
    const patternAuthorizationRef = useRef(effectivePatternAuthorizationBinding);
    patternAuthorizationRef.current = effectivePatternAuthorizationBinding;
    const [, refreshPatternAuthorization] = useReducer(value => value + 1, 0);
    const authorizationExpiresAt = currentCardProjectAuthorizationExpiresAt(effectivePatternAuthorizationBinding);
    const projectAuthorizationCurrent = authorizationExpiresAt > 0;
    useEffect(() => {
      if (!authorizationExpiresAt) return undefined;
      const timeout = setTimeout(
        () => refreshPatternAuthorization(),
        Math.max(0, authorizationExpiresAt - Date.now()) + 1,
      );
      return () => clearTimeout(timeout);
    }, [authorizationExpiresAt]);

    const patternCardAccess = useMemo(() => {
      const expectedCard = cardLink?.expectedCard || null;
      const readiness = classifyCardReadiness(cardLink?.readiness || {}, { expectedCard });
      const expectedCardId = String(expectedCard?.id || expectedCard?.cardId || '').trim().toLowerCase();
      const exactPair = Boolean(expectedCardId) && readiness.cardId.toLowerCase() === expectedCardId;
      if (!exactPair) return 'recovery';
      // Playback access, not command access: this screen only sends patterns,
      // brightness, and scenes, which the card keeps serving across a WiFi
      // transition. Installs from here re-check the command gate themselves.
      if (readiness.playbackAccess === 'blank') return 'blank';
      // `connected` is the command gate (isCardLinkConnected), which closes
      // during a WiFi transition. Use its playback sibling so a lit, matching
      // card does not lose pattern control while the radio reassociates.
      const playbackLinkReady = isCardLinkPlaybackReady(cardLink || {}, { expectedCard })
        && !cardLink?.cardBlank;
      return readiness.playbackAccess === 'ready' && (connected || playbackLinkReady) ? 'ready' : 'recovery';
    }, [cardLink, connected]);
    const patternAccessRef = useRef(patternCardAccess);
    patternAccessRef.current = patternCardAccess;
    const previousPatternAccessRef = useRef(patternCardAccess);

    const hasCurrentProjectAuthorization = useCallback(() => (
      hasCurrentCardProjectAuthorization(patternAuthorizationRef.current)
    ), []);
    const currentPatternCardAccess = useCallback(() => {
      const access = patternAccessRef.current;
      if (access !== 'ready') return access;
      return hasCurrentProjectAuthorization() ? 'ready' : 'project';
    }, [hasCurrentProjectAuthorization]);
    const matchesCurrentCardProjectEvidence = useCallback((evidence = {}) => {
      const binding = patternAuthorizationRef.current;
      const matches = hasCurrentProjectAuthorization()
        && String(evidence.cardId || '').trim().toLowerCase() === String(binding.cardId || '').trim().toLowerCase()
        && String(evidence.firmwareVersion || '').trim() === String(binding.firmwareVersion || '').trim()
        && String(evidence.buildId || '').trim() === String(binding.buildId || '').trim()
        && String(evidence.projectId || '').trim() === String(binding.installedProjectId || '').trim()
        && String(evidence.projectFingerprint || '').trim().toLowerCase() === String(binding.installedProjectFingerprint || '').trim().toLowerCase();
      // This ran against a fresh /api/firmware-info read, so a match is the
      // strongest proof available that the authorization's claim still holds.
      // Renew the staleness window off it rather than let a clock revoke a
      // fact the card just re-confirmed. Never called during render.
      if (matches) renewCardEditAuthorization(binding);
      return matches;
    }, [hasCurrentProjectAuthorization]);

    const invalidatePendingPreview = useCallback(() => {
      browsePreviewSeq.current += 1;
      livePreviewSeq.current += 1;
      if (livePreviewTimer.current) {
        clearTimeout(livePreviewTimer.current);
        livePreviewTimer.current = null;
      }
      dispatchPreviewAction({ type: 'reset' });
      setPreviewFailure(null);
    }, []);

    const blockPatternCardEffect = useCallback((access = patternAccessRef.current) => {
      invalidatePendingPreview();
      setPatternCardGate(access === 'blank' ? 'blank' : access === 'project' ? 'project' : 'recovery');
      setHandoffUrl('');
      setStatusKind('err');
      setStatus(
        access === 'blank'
          ? 'This card has no project yet. Set up its LED strips, then install this Studio project.'
          : access === 'project'
            ? 'Open Hardware and verify that this exact Studio project is still installed on this card before sending lights.'
            : 'This card is not ready for pattern commands. Recover and verify it before sending lights.',
      );
    }, [invalidatePendingPreview]);

    useEffect(() => {
      // Every readiness poll that still reports the exact bound card, boot,
      // and installed project is fresh evidence that the authorization's claim
      // holds, so it renews the window. This can only renew, never issue:
      // renewCardEditAuthorization re-checks the full identity binding, so a
      // poll describing a different card or a diverged project fingerprint
      // renews nothing and the authorization lapses exactly as before.
      if (patternCardAccess !== 'ready') return;
      renewCardEditAuthorization(effectivePatternAuthorizationBinding);
    }, [patternCardAccess, effectivePatternAuthorizationBinding]);

    const previousProjectAuthorizationRef = useRef(projectAuthorizationCurrent);
    useEffect(() => {
      const previous = previousProjectAuthorizationRef.current;
      previousProjectAuthorizationRef.current = projectAuthorizationCurrent;
      if (previous && !projectAuthorizationCurrent && patternAccessRef.current === 'ready') {
        setColorOrderOpen(false);
        blockPatternCardEffect('project');
      }
    }, [blockPatternCardEffect, projectAuthorizationCurrent]);

    useEffect(() => {
      // Card authority is tied to the exact readiness envelope that existed
      // when the gesture began. A reboot, disconnect, or recovery transition
      // must invalidate an in-flight bridge acquisition so its late promise
      // cannot replay the old selection after authority has been lost.
      const previousAccess = previousPatternAccessRef.current;
      previousPatternAccessRef.current = patternCardAccess;
      const linkState = String(cardLink?.state || '');
      const transitionalBridgeCheck = linkState === 'connecting'
        || linkState === 'revalidating'
        || linkState === 'reconnecting-bridge'
        || (linkState === 'connected-bridge' && !cardLink?.readiness);
      const explicitReadinessLoss = Boolean(cardLink?.readiness)
        && classifyCardReadiness(cardLink.readiness, { expectedCard: cardLink?.expectedCard || null }).playbackAccess !== 'ready';
      if (patternCardAccess !== 'ready' && previousAccess === 'ready'
        && (explicitReadinessLoss || !transitionalBridgeCheck)) {
        setColorOrderOpen(false);
        blockPatternCardEffect(patternCardAccess);
        return;
      }
      if (!transitionalBridgeCheck) invalidatePendingPreview();
      if (patternCardAccess !== 'ready' && !transitionalBridgeCheck) setHandoffUrl('');
    }, [blockPatternCardEffect, cardLink?.expectedCard, cardLink?.readiness, cardLink?.state, invalidatePendingPreview, patternCardAccess]);

    // Warm default so first load reads warm (Lava Lamp-like) like the mockup,
    // unless a real saved default look exists.
    //
    // Distinguishing factory aurora from a user-picked pattern: a fresh project
    // is always seeded with a defaultLook of patternId 'aurora' (the factory
    // default), so the presence of a defaultLook alone does not prove the user
    // chose anything. We treat the saved pattern as a real, deliberate choice
    // only when at least one of these is true:
    //   - the resolved patternId is something other than the factory 'aurora'
    //   - the user named the project (name is not the default 'Untitled Project')
    //   - the project already has saved looks (the user has saved at least once)
    // When none hold, this looks like an untouched factory project, so we prefer
    // the warm default for the INITIAL preview only and never mutate saved state.
    const warmDefaultPatternId = useMemo(() => defaultWarmPatternId(), []);
    const FACTORY_DEFAULT_PATTERN_ID = 'aurora';
    const savedDefaultPatternId = standaloneController?.defaultLook?.patternId;
    const hasNamedProject = Boolean(projectName) && projectName !== 'Untitled Project';
    const hasSavedLooks = Array.isArray(standaloneController?.looks) && standaloneController.looks.length > 0;
    const looksLikeFactoryProject =
      savedDefaultPatternId === FACTORY_DEFAULT_PATTERN_ID && !hasNamedProject && !hasSavedLooks;
    const hasSavedDefaultPattern = Boolean(
      standaloneController?.defaultLook &&
      (getCardPatternById(savedDefaultPatternId)
        || (workspaceAssets.ready && getPatternById(savedDefaultPatternId))) &&
      !looksLikeFactoryProject,
    );
    const savedGlobalLook = normalizeSectionVisualLook(
      hasSavedDefaultPattern
        ? standaloneController?.defaultLook
        : { ...(standaloneController?.defaultLook || {}), patternId: warmDefaultPatternId },
    );
    const savedLooks = normalizeSavedLooks(standaloneController?.looks);
    const activeLookId = standaloneController?.activeLookId || '';
    const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
    const latestBoardRef = useRef(board);
    const latestControllerRef = useRef(standaloneController);
    latestBoardRef.current = board;
    latestControllerRef.current = standaloneController;

    const sectionTargets = useMemo(
      () => deriveSectionTargets({ strips, patchBoard: board, defaultLook: savedGlobalLook }),
      [
        strips, board,
        savedGlobalLook.patternId, savedGlobalLook.brightness, savedGlobalLook.speed,
        savedGlobalLook.hueShift, savedGlobalLook.customHue, savedGlobalLook.customSaturation,
        savedGlobalLook.customBreathe, savedGlobalLook.breatheLowerPct,
        savedGlobalLook.breatheUpperPct, savedGlobalLook.breatheCycleSeconds,
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
    const breatheSummary = !look.customBreathe
      ? 'Breathe off'
      : look.breatheLowerPct === look.breatheUpperPct
        ? `Breathe · ${look.breatheLowerPct}% steady`
        : `Breathe · ${look.breatheLowerPct}–${look.breatheUpperPct}% · ${look.breatheCycleSeconds}s`;
    const effectiveSectionTargets = useMemo(
      () => sectionTargets.map(target => ({ ...target, look: resolveDraftTargetLook(target) })),
      [resolveDraftTargetLook, sectionTargets],
    );
    const patternPreviewSegments = useMemo(
      () => buildPatternPreviewSegments({
        strips,
        patchBoard: board,
        targets: effectiveSectionTargets,
        resolvePatternId: resolveCodePatternId,
        paletteForPattern: patternId => (
          REAL_PATTERN_BY_ID.get(patternId)?.pal || adaptPattern(patternId)?.pal
        ),
      }),
      [board, effectiveSectionTargets, strips],
    );
    const previewTargetIds = useMemo(
      () => patternPreviewSegments.map(segment => segment.id),
      [patternPreviewSegments],
    );
    const previewTargetKey = previewTargetIds.join('|');
    const [previewUiState, setPreviewUiState] = useState(() => ({
      projectId,
      ...readPatternPreviewUiState({ projectId, targetIds: previewTargetIds }),
    }));
    useEffect(() => {
      setPreviewUiState(previous => {
        if (previous.projectId !== projectId) {
          return {
            projectId,
            ...readPatternPreviewUiState({ projectId, targetIds: previewTargetIds }),
          };
        }
        if (previewTargetIds.includes(previous.lastTargetId)) return previous;
        return { ...previous, lastTargetId: previewTargetIds[0] || '' };
      });
    }, [projectId, previewTargetKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const previewMode = previewUiState.projectId === projectId && previewUiState.mode === 'piece'
      ? 'piece'
      : 'strip';
    const lastPreviewTargetId = previewTargetIds.includes(previewUiState.lastTargetId)
      ? previewUiState.lastTargetId
      : (previewTargetIds[0] || '');
    useEffect(() => {
      if (previewUiState.projectId !== projectId) return;
      writePatternPreviewUiState({
        projectId,
        state: { mode: previewMode, lastTargetId: lastPreviewTargetId },
      });
    }, [lastPreviewTargetId, previewMode, previewUiState.projectId, projectId]);
    const visiblePatternPreviewSegments = previewMode === 'piece'
      ? patternPreviewSegments
      : patternPreviewSegments.filter(segment => segment.id === lastPreviewTargetId);
    const patternPreviewViewBox = previewMode === 'piece'
      ? viewBox
      : fitPreviewViewBox(visiblePatternPreviewSegments, viewBox);
    const previewTargetName = previewMode === 'piece'
      ? 'Whole piece'
      : (visiblePatternPreviewSegments[0]?.label || 'LED strip');

    const rawPlaylist = isImplicitDefaultPatternPlaylist(standaloneController?.playlist)
      ? []
      : standaloneController?.playlist;
    const playlist = normalizeCardPlaylist(rawPlaylist, { savedLooks, allowEmpty: true });

    // ── adapted (real) pattern bank + saved mixes in the mockup's shape ──
    const realMixes = useMemo(
      () => savedLooks.map(adaptSavedLook).filter(Boolean),
      [savedLooks],
    );
    const customPatterns = useMemo(() => (
      workspaceAssets.ready
        ? loadCustomPatterns().map(pattern => adaptPattern({
          ...pattern,
          label: pattern.name || pattern.label || pattern.id,
          description: pattern.description || 'Custom Pattern Lab pattern.',
        }))
        : []
    ), [workspaceAssets.generation, workspaceAssets.ready]);
    const customPatternById = useMemo(
      () => new Map(customPatterns.map(pattern => [pattern.id, pattern])),
      [customPatterns],
    );
    const ALL = useMemo(() => [...realMixes, ...customPatterns, ...REAL_PATTERNS], [customPatterns, realMixes]);
    // Map an adapted mix-card id back to its real saved look (adaptSavedLook
    // sets the card id to look.id when present, else `mix-${patternId}`).
    const findSavedLook = useCallback(
      (cardId) => savedLooks.find(l => (l.id || `mix-${l.patternId}`) === cardId),
      [savedLooks],
    );
    // The selected pattern is driven by the live look.patternId.
    const selId = customPatternById.has(activePatternId) ? activePatternId : look.patternId;
    const sel = REAL_PATTERN_BY_ID.get(selId) || customPatternById.get(selId) || adaptPattern(selId) || ALL[0];
    const tint = sel.pal[2] || sel.pal[sel.pal.length - 1];
    const currentComboLabel = (() => {
      const sections = effectiveSectionTargets.filter(t => t.kind === 'section');
      if (sections.length > 2) return `${sections.length}-layer mix`;
      if (sections.length) {
        return sections.map(t => `${targetLabel(t)} ${getCardPatternById(t.look?.patternId)?.label || t.look?.patternId}`).join(' + ');
      }
      return `${sel.label} whole piece`;
    })();
    const mixLabel = mixName.trim() || currentComboLabel;

    const filtered = ALL.filter((p) => {
      if (cat === "mix") { if (!p.mix) return false; } else if (cat !== "all" && p.cat !== cat) return false;
      if (q && !p.label.toLowerCase().includes(q.toLowerCase())) return false;
      return true;
    });
    useEffect(() => {
      const node = patternSentinelRef.current;
      if (!node || typeof IntersectionObserver === 'undefined') return undefined;
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisibleCount(count => Math.min(filtered.length, count + PATTERN_PAGE));
        }
      }, { rootMargin: '600px 0px' });
      observer.observe(node);
      return () => observer.disconnect();
    }, [cat, q, filtered.length]);
    const playlistSize = playlist.length;

    // ── controller / preview helpers (ported from PatternsScreen) ───────
    const runtimeBuild = useMemo(() => {
      try {
        return {
          runtimePackage: buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: board, compiledWiring, standaloneController }),
          error: null,
        };
      } catch (error) {
        return { runtimePackage: null, error };
      }
    }, [projectId, projectName, strips, board, compiledWiring, standaloneController]);
    const runtimePackage = runtimeBuild.runtimePackage;
    const hardwareConfigurationIssue = runtimeBuild.error
      ? String(runtimeBuild.error.message || runtimeBuild.error).replace('is already owned by an LED output or another control', 'is already used by an LED output or another control')
      : '';
    const encoderPins = standaloneController?.controls?.encoder || {};
    const canRemoveDuplicateAlternatePress = hardwareConfigurationIssue
      && Number(encoderPins.press) >= 0
      && Number(encoderPins.press) === Number(encoderPins.alternatePress);
    const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

    const updateController = (patch) => {
      return setStandaloneController(prev => {
        const current = prev || {};
        return {
          ...current,
          ...patch,
          led: patch.led ? { ...(current.led || {}), ...patch.led } : current.led,
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

    const removeDuplicateAlternatePress = () => {
      const result = updateController({ controls: { encoder: { alternatePress: -1 } } });
      if (result?.ok === false) {
        setStatusKind('err');
        setStatus(result.errors?.[0]?.message || 'Open wiring to change the duplicate GPIO assignment.');
      }
    };

    const scheduleLivePreview = useCallback((nextLook, target = selectedTarget, delayMs = 80, { bridgeAuthority = null } = {}) => {
      const hasCurrentAuthority = () => {
        if (!hasCurrentProjectAuthorization()) return false;
        if (patternAccessRef.current === 'ready') return true;
        if (!bridgeAuthority) return false;
        const state = getCardBridgeState();
        return Boolean(
          state.verified
          && state.identityVerified
          && state.runtimePlaybackReady
          && state.lifecycle === bridgeAuthority.lifecycle
          && normalizeCardHost(state.host) === bridgeAuthority.host
          && state.card?.id === bridgeAuthority.cardId
          && state.card?.firmwareVersion === bridgeAuthority.firmwareVersion
          && state.card?.buildId === bridgeAuthority.buildId
        );
      };
      if (!livePreview) {
        setStatusKind('');
        setStatus('');
        return;
      }
      if (!hasCurrentAuthority()) {
        blockPatternCardEffect(currentPatternCardAccess());
        return;
      }
      setPatternCardGate('');
      setHandoffUrl('');
      if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
      const sequence = ++livePreviewSeq.current;
      latestPreviewIntent.current = { look: nextLook, target };
      dispatchPreviewAction({ type: 'start', revision: sequence });
      setPreviewFailure(null);
      const zone = target?.kind === 'section' ? target.zoneId || target.id : '';
      livePreviewTimer.current = setTimeout(async () => {
        setHandoffUrl('');
        if (!hasCurrentAuthority()) {
          blockPatternCardEffect(currentPatternCardAccess());
          return;
        }
        try {
          const evidence = await readCardProjectEvidence({ host: cardHost, transport: cardLink?.transport });
          if (sequence !== livePreviewSeq.current) return;
          if (!matchesCurrentCardProjectEvidence(evidence)) {
            blockPatternCardEffect('project');
            return;
          }
          if (zone) {
            if (!runtimePackage) throw runtimeBuild.error;
            await ensureCardSectionsForPreview({
              host: cardHost,
              requiredZoneIds: [zone],
              runtimePackage,
            });
            if (sequence !== livePreviewSeq.current) return;
            if (!hasCurrentAuthority()) {
              blockPatternCardEffect(currentPatternCardAccess());
              return;
            }
          }
          await pushLivePreviewToCard(
            { ...nextLook, zone, syncZones: target?.kind === 'section' ? false : true },
            {
              host: cardHost,
              timeoutMs: 2200,
              fallbackMissingZoneToAll: false,
              preferBridge: localCard || (typeof window !== 'undefined' && window.location?.protocol === 'https:'),
              revision: sequence,
            },
          );
          if (sequence === livePreviewSeq.current && hasCurrentAuthority()) {
            dispatchPreviewAction({ type: 'confirm', revision: sequence });
            setPreviewFailure(null);
            markCardLookConfirmed({ ...nextLook, zone, syncZones: target?.kind === 'section' ? false : true });
            setStatusKind('');
            setStatus('');
          }
        } catch (error) {
          if (error?.reason === 'superseded') {
            return;
          }
          if (sequence === livePreviewSeq.current) {
            const failure = classifyCardActionFailure(error);
            dispatchPreviewAction({ type: 'fail', revision: sequence, error: failure.message });
            setPreviewFailure(failure);
            setStatusKind('err');
            if (error?.reason === 'mixed-content') {
              setHandoffUrl(buildCardConfigHandoffUrl(cardHost, runtimePackage));
            }
            setStatus(failure.message);
          }
        }
      }, delayMs);
    }, [blockPatternCardEffect, cardHost, cardLink?.transport, currentPatternCardAccess, hasCurrentProjectAuthorization, livePreview, localCard, markCardLookConfirmed, matchesCurrentCardProjectEvidence, runtimeBuild.error, runtimePackage, selectedTarget]);

    const retryLatestPreview = useCallback(() => {
      const latest = latestPreviewIntent.current;
      if (!latest) return;
      scheduleLivePreview(latest.look, latest.target, 0);
    }, [scheduleLivePreview]);

    const openConnectionCenter = useCallback(() => {
      document.querySelector('[data-testid="card-link-status"]')?.click();
    }, []);

    useEffect(() => () => {
      invalidatePendingPreview();
    }, [invalidatePendingPreview]);

    useEffect(() => {
      if (sectionTargets.some(target => target.id === selectedTargetId)) return;
      setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    }, [sectionTargets, selectedTargetId]);

    useEffect(() => {
      invalidatePendingPreview();
      setHandoffUrl('');
      setStatusKind('');
      setStatus('');
      setDraftLooks({});
      setMixName('');
      setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    }, [invalidatePendingPreview, projectRevision]);

    useEffect(() => {
      if (
        previewUiState.projectId !== projectId ||
        !previewTargetIds.includes(lastPreviewTargetId)
      ) return;
      const restoreKey = `${projectId}:${lastPreviewTargetId}`;
      if (syncedPreviewSelectionRef.current === restoreKey) return;
      syncedPreviewSelectionRef.current = restoreKey;
      setSelectedTargetId(lastPreviewTargetId);
    }, [lastPreviewTargetId, previewTargetKey, previewUiState.projectId, projectId]);

    useEffect(() => {
      if (cardReturnConsumed.current || typeof window === 'undefined') return;
      const params = new URLSearchParams(window.location.search);
      const requestedPatternValue = String(params.get('editPattern') || '').trim();
      const requestedLookValue = String(params.get('editLook') || '').trim();
      const requestedPatternId = requestedPatternValue.toLowerCase();
      const requestedLookId = requestedLookValue.toLowerCase();
      if (!requestedPatternId && !requestedLookId) return;
      const requestedIntent = requestedPatternValue
        ? `pattern:${requestedPatternValue}`
        : `look:${requestedLookValue}`;
      if (!consumeCardEditAuthorization({
        ...patternAuthorizationRef.current,
        intent: requestedIntent,
      })) {
        cardReturnConsumed.current = true;
        invalidatePendingPreview();
        if (go) go('card');
        else window.location.hash = '#screen=card&section=overview';
        return;
      }
      cardReturnConsumed.current = true;

      const returnedHost = params.get('cardHost') || '';
      if (isLocalCardHost(returnedHost)) {
        const normalizedHost = normalizeCardHost(returnedHost);
        writeStoredCardHost(normalizedHost);
        setCardHost(normalizedHost);
      }

      if (requestedPatternId && getCardPatternById(requestedPatternId)) {
        setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
        setDraftLooks({
          [ALL_SECTIONS_TARGET_ID]: normalizeSectionVisualLook({
            ...savedGlobalLook,
            patternId: requestedPatternId,
          }),
        });
        setStatusKind('ok');
        setStatus(`Opened ${getCardPatternById(requestedPatternId)?.label || requestedPatternId} from the card. Adjust it here, then install when ready.`);
      } else if (requestedLookId) {
        const returnedLook = savedLooks.find(savedLook => String(savedLook.id || '').toLowerCase() === requestedLookId);
        if (returnedLook) {
          setPatchBoard(applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook: returnedLook }));
          setStandaloneController(previous => ({
            ...(previous || {}),
            defaultLook: returnedLook.defaultLook,
            activeLookId: returnedLook.id,
            looks: savedLooks,
          }));
          setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
          setDraftLooks({});
          setStatusKind('ok');
          setStatus(`Opened ${returnedLook.label || returnedLook.id} from the card. Adjust it here, then install when ready.`);
        } else {
          setStatusKind('err');
          setStatus('That saved card look is not in this Studio project. Open the matching project, then return from the card again.');
        }
      } else {
        setStatusKind('err');
        setStatus('That card pattern is not supported by this Studio build. Update Studio or choose another card pattern.');
      }

      params.delete('editPattern');
      params.delete('editLook');
      const search = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
    }, [board, go, invalidatePendingPreview, savedGlobalLook, savedLooks, setPatchBoard, setStandaloneController, strips]);

    const updatePreviewLook = (patch, { push = true } = {}) => {
      if (!selectedTarget) return null;
      const nextLook = normalizeSectionVisualLook({ ...look, ...patch });
      setDraftLooks(prev => ({ ...prev, [selectedTarget.id]: nextLook }));
      markProjectEdited();
      if (push) scheduleLivePreview(nextLook, selectedTarget);
      return nextLook;
    };

    const scheduleBrowseLivePreview = useCallback((nextLook, target) => {
      if (!nextLook) return;
      if (livePreview && currentPatternCardAccess() !== 'ready') {
        blockPatternCardEffect(currentPatternCardAccess());
        return;
      }
      setPatternCardGate('');
      const needsBridge = livePreview && (
        localCard || (typeof window !== 'undefined' && window.location?.protocol === 'https:')
      );
      if (!needsBridge) {
        scheduleLivePreview(nextLook, target);
        return;
      }

      const sequence = ++browsePreviewSeq.current;
      const scheduleVerifiedBridgePreview = async () => {
        const firmwareGap = cardBridgeFeatureGap('frame');
        if (firmwareGap) {
          setHandoffUrl('');
          setStatusKind('err');
          setStatus(firmwareGap.message);
          return;
        }
        const expectedCard = cardLink?.expectedCard || cardLink?.card || null;
        const originalBootId = String(cardLink?.validatedBootId || cardLink?.readiness?.bootId || '');
        const status = await sendCardBridgeRequest('status', { cache: 'no-store', nonce: Date.now() }, {
          host: cardHost,
          retryOnTimeout: false,
        });
        const readiness = classifyCardReadiness(status, { expectedCard });
        const bridgeState = getCardBridgeState();
        const exactFreshAuthority = readiness.playbackAccess === 'ready'
          && readiness.cardId === String(expectedCard?.id || expectedCard?.cardId || '')
          && (!expectedCard?.firmwareVersion || status.firmwareVersion === expectedCard.firmwareVersion)
          && (!expectedCard?.buildId || status.buildId === expectedCard.buildId)
          && Boolean(originalBootId)
          && readiness.bootId === originalBootId
          && bridgeState.verified
          && bridgeState.identityVerified
          && bridgeState.runtimePlaybackReady
          && normalizeCardHost(bridgeState.host) === normalizeCardHost(cardHost);
        if (!exactFreshAuthority || sequence !== browsePreviewSeq.current) {
          blockPatternCardEffect(currentPatternCardAccess());
          return;
        }
        setStatusKind('');
        setStatus('');
        scheduleLivePreview(nextLook, target, 0, {
          bridgeAuthority: {
            lifecycle: bridgeState.lifecycle,
            host: normalizeCardHost(bridgeState.host),
            cardId: readiness.cardId,
            firmwareVersion: status.firmwareVersion,
            buildId: status.buildId,
            bootId: readiness.bootId,
          },
        });
      };
      const bridgeOpen = hasCardBridge();
      const bridgeState = getCardBridgeState();
      if (
        bridgeOpen && bridgeState.verified && bridgeState.identityVerified && bridgeState.runtimePlaybackReady &&
        normalizeCardHost(bridgeState.host) === normalizeCardHost(cardHost)
      ) {
        void scheduleVerifiedBridgePreview().catch(error => {
          if (sequence !== browsePreviewSeq.current) return;
          setStatusKind('err');
          setStatus(error?.message || 'The local card did not reverify as Ready. Recover it before sending lights.');
        });
        return;
      }

      const attempt = acquireCardBridgeFromGesture(cardHost, {
        studioUrl: typeof window !== 'undefined' ? window.location.href : '',
        timeoutMs: 10000,
      });
      setHandoffUrl('');
      setStatusKind('');
      setStatus('Connecting to the local Lightweaver card…');
      const onBridgeChanged = () => {
        if (sequence !== browsePreviewSeq.current) return;
        const state = getCardBridgeState();
        if (!state.verified) return;
        const firmwareGap = cardBridgeFeatureGap('frame');
        if (!firmwareGap) return;
        browsePreviewSeq.current += 1;
        window.removeEventListener(CARD_BRIDGE_CHANGED_EVENT, onBridgeChanged);
        setStatusKind('err');
        setStatus(firmwareGap.message);
      };
      window.addEventListener(CARD_BRIDGE_CHANGED_EVENT, onBridgeChanged);
      void attempt.ready.then(() => {
        window.removeEventListener(CARD_BRIDGE_CHANGED_EVENT, onBridgeChanged);
        if (sequence !== browsePreviewSeq.current) return;
        void scheduleVerifiedBridgePreview().catch(error => {
          if (sequence !== browsePreviewSeq.current) return;
          setStatusKind('err');
          setStatus(error?.message || 'The local card did not reverify as Ready. Recover it before sending lights.');
        });
      }).catch(error => {
        window.removeEventListener(CARD_BRIDGE_CHANGED_EVENT, onBridgeChanged);
        if (sequence !== browsePreviewSeq.current) return;
        setStatusKind('err');
        if (error?.reason === 'popup-blocked') {
          setStatus('Allow the Lightweaver card window, then try the pattern again.');
        } else if (error?.reason === 'bridge-timeout') {
          setStatus('The card page opened but did not answer. Check that this device is on the card\'s Wi-Fi.');
        } else {
          setStatus(error?.message || 'The local card did not connect. Open Flash to update the card, then try again.');
        }
      });
    }, [blockPatternCardEffect, cardHost, currentPatternCardAccess, livePreview, localCard, scheduleLivePreview]);

    // Clicking a target tab pushes that target's current look to its zone
    // (debounced) so the physical strip follows the selection.
    const selectTarget = (target) => {
      if (!target) return;
      invalidatePendingPreview();
      setSelectedTargetId(target.id);
      setPreviewUiState(previous => ({
        ...previous,
        projectId,
        mode: target.kind === 'section' ? 'strip' : 'piece',
        lastTargetId: target.kind === 'section' && previewTargetIds.includes(target.id)
          ? target.id
          : (previewTargetIds.includes(previous.lastTargetId) ? previous.lastTargetId : previewTargetIds[0] || ''),
      }));
      // Picking a target only changes what the controls edit — with live
      // preview off nothing is sent, so there is nothing to report. The
      // "Live preview is off…" note belongs to actual look changes only.
      if (!livePreview) return;
      if (!connected) {
        setStatusKind('err');
        setStatus(`Not connected to the card, so the lights can't follow this selection. Use Connect to card in the bottom bar.`);
        return;
      }
      scheduleLivePreview(resolveDraftTargetLook(target), target, 150);
    };

    const choosePatternPreviewTarget = (value) => {
      if (value === 'piece') {
        setPreviewUiState(previous => ({ ...previous, projectId, mode: 'piece' }));
        return;
      }
      const target = sectionTargets.find(candidate => candidate.id === value && candidate.kind === 'section');
      if (target && previewTargetIds.includes(target.id)) selectTarget(target);
    };

    const stepPatternPreviewTarget = (direction) => {
      if (previewMode !== 'strip') return;
      const currentIndex = previewTargetIds.indexOf(lastPreviewTargetId);
      const nextId = previewTargetIds[currentIndex + direction];
      if (nextId) choosePatternPreviewTarget(nextId);
    };

    const togglePatternPiecePreview = () => {
      const nextMode = previewMode === 'piece' ? 'strip' : 'piece';
      if (nextMode === 'strip' && previewTargetIds.includes(lastPreviewTargetId)) {
        setSelectedTargetId(lastPreviewTargetId);
      }
      setPreviewUiState(previous => ({
        ...previous,
        projectId,
        mode: nextMode,
        lastTargetId: previewTargetIds.includes(previous.lastTargetId)
          ? previous.lastTargetId
          : previewTargetIds[0] || '',
      }));
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
        nextBoard = applyLookToPatchBoard({ patchBoard: nextBoard, strips, targetId: ALL_SECTIONS_TARGET_ID, look: nextDefaultLook });
      }
      for (const target of sectionTargets) {
        if (target.kind !== 'section' || !normalizedDraftLooks[target.id]) continue;
        nextBoard = applyLookToPatchBoard({ patchBoard: nextBoard, strips, targetId: target.id, look: normalizedDraftLooks[target.id] });
      }
      const nextTargets = deriveSectionTargets({ strips, patchBoard: nextBoard, defaultLook: nextDefaultLook });
      let nextController = { ...(standaloneController || {}), defaultLook: nextDefaultLook };
      if (!saveNamedLook) return { nextLook, nextBoard, nextController, nextTargets };
      const resolvedLabel = label || mixName.trim() || currentComboLabel;
      nextController = saveCurrentLookToController(standaloneController, {
        lookId: uniqueLookId ? `combo-${Date.now()}-${++savedComboSeq.current}` : '',
        label: resolvedLabel,
        defaultLook: nextDefaultLook,
        targets: nextTargets,
      });
      return { nextLook, nextBoard, nextController, nextTargets };
    };

    // ── handlers ────────────────────────────────────────────────────────
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
          encoder: { ...(controller?.controls?.encoder || {}), patternCycleIds: derivePlaylistLookIds(nextPlaylist) },
        },
      };
    };

    const offerCardHandoff = (runtimePackageForCard, message) => {
      setHandoffUrl(buildCardConfigHandoffUrl(cardHost, runtimePackageForCard));
      setStatusKind('err');
      setStatus(message);
    };
    const reportCardPageOpenResult = (result) => {
      if (result?.ok) return true;
      setStatusKind('err');
      setStatus(result?.reason === 'popup-blocked'
        ? 'The browser blocked the card window. Allow popups for Studio, then try again.'
        : 'The card address is not a valid local Lightweaver address. Check it, then try again.');
      return false;
    };
    const openCardInstaller = async () => {
      if (!handoffUrl) return;
      if (currentPatternCardAccess() !== 'ready') {
        blockPatternCardEffect(currentPatternCardAccess());
        return;
      }
      try {
        const evidence = await readCardProjectEvidence({ host: cardHost, transport: cardLink?.transport });
        if (!matchesCurrentCardProjectEvidence(evidence)) {
          blockPatternCardEffect('project');
          return;
        }
      } catch (error) {
        setStatusKind('err');
        setStatus(error?.message || 'The card could not be reverified before opening the installer.');
        return;
      }
      const url = new URL(handoffUrl);
      reportCardPageOpenResult(openLocalCardPage(cardHost, {
        path: `${url.pathname}${url.search}${url.hash}`,
        reason: 'card-installer',
      }));
    };

    const checkCardLayoutWriteSafety = async (runtimePackageForCard, actionLabel = 'saving') => {
      const localPixels = Number(runtimePackageForCard?.config?.led?.pixels) || 0;
      const discovered = await discoverCardStatus({ preferredHost: cardHost, timeoutMs: 650, persist: true });
      if (!discovered.connected) return { ok: true, host: cardHost };
      if (discovered.host) { setCardHost(discovered.host); writeStoredCardHost(discovered.host); }
      const cardPixels = Number(discovered.status?.led?.pixels);
      if (!Number.isFinite(cardPixels) || cardPixels <= 0 || localPixels <= 0 || cardPixels < localPixels * 2) {
        return { ok: true, host: discovered.host || cardHost };
      }
      setStatusKind('err');
      setStatus(`Stopped before ${actionLabel}: this project is the default ${localPixels}-pixel layout, but the card is configured for ${cardPixels} pixels. Load the real project or set the LED counts before saving to the card.`);
      return { ok: false, host: discovered.host || cardHost };
    };

    const savePreviewToCard = async () => {
      if (currentPatternCardAccess() !== 'ready') {
        blockPatternCardEffect(currentPatternCardAccess());
        return;
      }
      if (installIntentRef.current) return;
      const installIntent = {};
      installIntentRef.current = installIntent;
      let packageForCard = null;
      try {
        const requestedRevision = projectLifecycle.editedRevision;
        const requestedGeneration = projectLifecycle.generation;
        const requestedDraftLooks = { ...draftLooks };
        const requestedBoard = board;
        const requestedController = standaloneController;
        const { nextLook, nextBoard, nextController: draftController } = buildCurrentHardwareState();
        const nextController = promotePatternFirst(draftController, nextLook.patternId);
        const prepared = prepareCardDeployment({
          projectId,
          projectName,
          projectRevision: requestedRevision,
          strips,
          patchBoard: nextBoard,
          compiledWiring,
          standaloneController: nextController,
        });
        const nextPackage = prepared.runtimePackage;
        // Test strip mode (see src/lib/testStrip.js): the saved design (project
        // state below) is untouched — only what actually goes to the card is
        // collapsed to the single bench-strip output/zone.
        // TODO(test-strip): checkCardLayoutWriteSafety's pixel-mismatch guard
        // was written for "default template vs. real card" detection and isn't
        // test-strip aware; it can misfire if the card is already on a test
        // strip of the same length as a previous session. Revisit if that
        // proves to be a real annoyance on the bench.
        const testStrip = readTestStrip();
        packageForCard = testStrip.enabled
          ? applyTestStripToRuntimePackage(nextPackage, testStrip.length)
          : nextPackage;
        setHandoffUrl('');
        setStatusKind('');
        setStatus('');
        prepareCardStoragePayload(packageForCard);
        const safety = await checkCardLayoutWriteSafety(packageForCard, 'saving');
        if (!safety.ok) return;
        if (currentPatternCardAccess() !== 'ready') {
          blockPatternCardEffect(currentPatternCardAccess());
          return;
        }
        const before = await readCardProjectEvidence({ host: safety.host || cardHost });
        if (!matchesCurrentCardProjectEvidence(before)) {
          blockPatternCardEffect('project');
          return;
        }
        const exactPrepared = { ...prepared, cardId: before.cardId };
        dispatchCardSave({ type: 'start', revision: requestedRevision });
        const response = await pushConfigToCard(packageForCard, {
          host: safety.host || cardHost,
          timeoutMs: 6000,
          reboot: 'if-needed',
          allowLayoutChange: testStrip.enabled || undefined,
          allowProjectChange: testStrip.enabled || undefined,
        });
        if (response?.state === 'staged') {
          throw new Error('The card kept this hardware change staged. Open Test & Install and confirm it on the real LEDs before it can be installed.');
        }
        const verification = await waitForCardDeploymentVerification(exactPrepared, {
          readEvidence: () => readCardProjectEvidence({ host: safety.host || cardHost }),
        });
        dispatchCardSave({ type: 'confirm' });
        const commitBoard = JSON.stringify(latestBoardRef.current) === JSON.stringify(requestedBoard)
          && JSON.stringify(latestBoardRef.current) !== JSON.stringify(nextBoard);
        const commitController = JSON.stringify(latestControllerRef.current) === JSON.stringify(requestedController)
          && JSON.stringify(latestControllerRef.current) !== JSON.stringify(nextController);
        if (commitBoard || commitController) {
          commitProjectStateWithoutEdit(() => {
            if (commitBoard) setPatchBoard(nextBoard);
            if (commitController) setStandaloneController(nextController);
          });
        }
        setDraftLooks(currentDrafts => Object.fromEntries(
          Object.entries(currentDrafts).filter(([targetId, currentLook]) => (
            !Object.prototype.hasOwnProperty.call(requestedDraftLooks, targetId)
            || JSON.stringify(currentLook) !== JSON.stringify(requestedDraftLooks[targetId])
          )),
        ));
        if (!testStrip.enabled) {
          markProjectInstalled({
            revision: requestedRevision,
            generation: requestedGeneration,
            cardId: verification.cardId,
            projectRevision: exactPrepared.config.projectRevision,
            projectFingerprint: exactPrepared.config.projectFingerprint,
          });
        }
        markCardLookConfirmed({
          ...nextLook,
          zone: testStrip.enabled ? '' : (selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : ''),
          syncZones: testStrip.enabled || selectedTarget?.kind !== 'section',
        });
        if (!response.rebooting) {
          // A test-strip card only has the one collapsed zone, so there is no
          // real per-section target to preview against — just sync the whole
          // (short) strip to the look that was just saved.
          const zone = testStrip.enabled
            ? ''
            : (selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '');
          if (currentPatternCardAccess() === 'ready') {
            await pushLivePreviewToCard(
              { ...nextLook, zone, syncZones: testStrip.enabled || nextLook.syncZones },
              { host: safety.host || cardHost, timeoutMs: 2200 },
            ).catch(() => null);
          }
        }
        setStatusKind('');
        setStatus('');
      } catch (error) {
        dispatchCardSave({ type: 'fail', error: error?.message });
        if (error?.reason === 'mixed-content') {
          offerCardHandoff(packageForCard, 'Saved in Studio. The browser blocked direct local-card access, so open the card installer to finish saving it on the card.');
        } else if (error?.reason === 'layout-mismatch' || error?.reason === 'project-mismatch' || error?.reason === 'config-too-large') {
          setStatusKind('err');
          setStatus(error.message);
        } else {
          setStatusKind('err');
          setStatus('Saved in the Studio, but could not reach the card. Copy or download the setup JSON and paste it on the card page.');
        }
      } finally {
        if (installIntentRef.current === installIntent) installIntentRef.current = null;
      }
    };

    const saveComboOnly = () => {
      const { nextController } = buildCurrentHardwareState({
        saveNamedLook: true,
        label: mixName.trim() || currentComboLabel,
        uniqueLookId: true,
      });
      const nextLooks = normalizeSavedLooks(nextController.looks);
      const saved = nextLooks[0];
      setPatchBoard(applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook: saved }));
      setStandaloneController(nextController);
      setDraftLooks({});
      setMixName('');
      setStatusKind('');
      setStatus('');
    };

    // Save the current pattern + all its tuned color/motion settings as a named,
    // recallable look. Same save path as "Save mix", surfaced next to the tuning
    // controls so a single tuned pattern (e.g. a custom Lava Lamp) can be kept.
    const savePreset = () => {
      const label = mixName.trim() || `${sel.label} · ${cardHueToDegrees(look.customHue)}°`;
      const { nextController } = buildCurrentHardwareState({
        saveNamedLook: true,
        label,
        uniqueLookId: true,
      });
      const nextLooks = normalizeSavedLooks(nextController.looks);
      const saved = nextLooks[0];
      setPatchBoard(applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook: saved }));
      setStandaloneController(nextController);
      setDraftLooks({});
      setStatusKind('');
      setStatus(`Saved “${label}”. Find it under the Mixes filter.`);
    };

    const writePlaylist = (nextItems) => {
      const normalized = normalizeCardPlaylist(nextItems, { savedLooks, allowEmpty: true });
      updateController({
        playlist: normalized,
        controls: { encoder: { patternCycleIds: derivePlaylistLookIds(normalized) } },
      });
      setStatusKind('');
      setStatus('');
    };

    const setPatternInPlaylist = (patternId, enabled) => {
      const next = enabled
        ? playlistContainsPattern(playlist, patternId)
          ? playlist
          : [...playlist, makePatternPlaylistItem(patternId)].filter(Boolean)
        : playlist.filter(item => !(item.type === 'pattern' && item.patternId === patternId));
      writePlaylist(next);
    };

    const setSavedLookInPlaylist = (savedLook, enabled) => {
      const next = enabled
        ? playlistContainsCombo(playlist, savedLook.id)
          ? playlist
          : [...playlist, makeComboPlaylistItem(savedLook)].filter(Boolean)
        : playlist.filter(item => !(item.type === 'combo' && item.lookId === savedLook.id));
      writePlaylist(next);
    };

    // Toggle playlist membership for any browse card (pattern or saved mix).
    const togglePl = (id, e) => {
      e.stopPropagation();
      const adapted = REAL_PATTERN_BY_ID.get(id);
      if (adapted) {
        setPatternInPlaylist(id, !playlistContainsPattern(playlist, id));
        return;
      }
      // saved mix card: id is the adapted look id; find the real saved look.
      const realLook = findSavedLook(id);
      if (realLook) setSavedLookInPlaylist(realLook, !playlistContainsCombo(playlist, realLook.id));
    };
    const inPlaylist = (id) => {
      if (REAL_PATTERN_BY_ID.has(id)) return playlistContainsPattern(playlist, id);
      const realLook = findSavedLook(id);
      return realLook ? playlistContainsCombo(playlist, realLook.id) : false;
    };

    // Select a browse card: pattern -> preview; saved mix -> apply look.
    const selectCard = (p) => {
      if (p.mix) {
        const realLook = findSavedLook(p.id);
        if (realLook) {
          const nextBoard = applySavedLookToPatchBoard({ patchBoard: board, strips, savedLook: realLook });
          setPatchBoard(nextBoard);
          setStandaloneController(prev => ({
            ...(prev || {}),
            defaultLook: realLook.defaultLook,
            activeLookId: realLook.id,
            looks: savedLooks,
          }));
          setDraftLooks({});
          setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
          scheduleBrowseLivePreview(normalizeSectionVisualLook(realLook.defaultLook), sectionTargets[0]);
        }
        return;
      }
      setActivePatternId(p.id);
      const nextLook = updatePreviewLook({ patternId: p.id }, { push: false });
      scheduleBrowseLivePreview(nextLook, selectedTarget);
    };

    const copyConfig = async () => {
      setHandoffUrl('');
      try {
        if (!runtimePackage) throw runtimeBuild.error;
        await navigator.clipboard.writeText(cardStorageJson(runtimePackage));
        setStatusKind('ok');
        setStatus('Setup JSON copied. Paste it into the card page on the same WiFi.');
      } catch (error) {
        setStatusKind('err');
        setStatus(error?.reason === 'config-too-large'
          ? error.message
          : 'Clipboard was blocked. Download the setup JSON instead.');
      }
    };

    const downloadConfig = () => {
      try {
        if (!runtimePackage) throw runtimeBuild.error;
        const blob = new Blob([cardStorageJson(runtimePackage)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeProjectName || 'lightweaver'}-chip-config.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        setStatusKind('err');
        setStatus(error?.reason === 'config-too-large'
          ? error.message
          : 'Could not prepare the setup download. Try again.');
      }
    };

    const repairLed = async () => {
      if (currentPatternCardAccess() !== 'ready') {
        blockPatternCardEffect(currentPatternCardAccess());
        return;
      }
      if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
      const sequence = ++livePreviewSeq.current;
      dispatchPreviewAction({ type: 'reset' });
      setPreviewFailure(null);
      setHandoffUrl('');
      setRecoveryConfirmation('');
      setStatusKind('');
      setStatus(`Sending warm-white LED repair to ${cardHostToUrl(cardHost)}...`);
      try {
        const evidence = await readCardProjectEvidence({ host: cardHost, transport: cardLink?.transport });
        if (sequence !== livePreviewSeq.current) return;
        if (!matchesCurrentCardProjectEvidence(evidence)) {
          blockPatternCardEffect('project');
          return;
        }
        await recoverCardLights(
          { patternId: 'warm-white', brightness: 1, syncZones: true },
          { host: cardHost, timeoutMs: 3200, restartCard: true },
        );
        if (sequence !== livePreviewSeq.current) return;
        setStatusKind('');
        setRecoveryConfirmation('pending');
        setStatus('Recovery frame sent. Do you see warm white on the real LEDs?');
      } catch (error) {
        if (sequence !== livePreviewSeq.current) return;
        setStatusKind('err');
        setRecoveryConfirmation('');
        if (error?.reason === 'identity-missing' || error?.reason === 'wrong-card') {
          // The write guard refuses an unpaired/wrong card. Surface it as the
          // one-tap pair affordance instead of a tiny reach-failure line.
          openConnectionCenter();
          setStatus('Pair this Lightweaver card before sending lights — tap Connect in the card panel.');
        } else {
          setStatus(error?.message || `LED repair could not reach ${cardHostToUrl(cardHost)}. Check power and WiFi, then turn on Use local card.`);
        }
      }
    };

    // TODO(test-strip): a "split" preview is inherently multi-zone (it shows
    // different sections different patterns at once), which has no coherent
    // meaning on a single collapsed bench-strip zone. This intentionally does
    // NOT apply applyTestStripToRuntimePackage — it already forces
    // allowLayoutChange: true (below) because committing a real split is
    // itself a real wiring change, so it pushes the actual design regardless
    // of test-strip mode. If bench-testing splits turns out to matter, the
    // real fix is a dedicated multi-output test rig, not a fake split on one
    // zone.
    const sendSplitPreview = async () => {
      if (currentPatternCardAccess() !== 'ready') {
        blockPatternCardEffect(currentPatternCardAccess());
        return;
      }
      const { nextLook, nextBoard, nextController } = buildCurrentHardwareState();
      const prepared = prepareCardDeployment({
        projectId,
        projectName,
        projectRevision: projectLifecycle.editedRevision,
        strips,
        patchBoard: nextBoard,
        compiledWiring,
        standaloneController: nextController,
      });
      const nextPackage = prepared.runtimePackage;
      setHandoffUrl('');
      setStatusKind('');
      setStatus('');
      try {
        const safety = await checkCardLayoutWriteSafety(nextPackage, 'applying split preview');
        if (!safety.ok) return;
        const before = await readCardProjectEvidence({ host: safety.host || cardHost });
        if (!matchesCurrentCardProjectEvidence(before)) {
          blockPatternCardEffect('project');
          return;
        }
        const response = await pushConfigToCard(nextPackage, { host: safety.host || cardHost, timeoutMs: 6000, reboot: 'if-needed', allowLayoutChange: true });
        if (response?.state === 'staged') {
          throw new Error('The split is staged but not installed. Open Test & Install and confirm it on the real LEDs.');
        }
        await waitForCardDeploymentVerification({ ...prepared, cardId: before.cardId }, {
          readEvidence: () => readCardProjectEvidence({ host: safety.host || cardHost }),
        });
        markCardLookConfirmed({ ...nextLook, zone: selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '', syncZones: selectedTarget?.kind !== 'section' });
        setPatchBoard(nextBoard);
        setStandaloneController(nextController);
        setDraftLooks({});
        if (!response.rebooting && currentPatternCardAccess() === 'ready') {
          const zone = selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '';
          await pushLivePreviewToCard({ ...nextLook, zone }, { host: safety.host || cardHost, timeoutMs: 2200 }).catch(() => null);
        }
        setStatusKind('');
        setStatus('');
      } catch (error) {
        if (error?.reason === 'mixed-content') {
          offerCardHandoff(nextPackage, 'The browser blocked direct local-card access from this public page. Open the card installer to apply this split on the card.');
        } else if (error?.reason === 'identity-missing' || error?.reason === 'wrong-card') {
          openConnectionCenter();
          setStatusKind('err');
          setStatus('Pair this Lightweaver card before sending lights — tap Connect in the card panel.');
        } else {
          setStatusKind('err');
          setStatus(error?.message || `Could not apply split preview to the card at ${cardHostToUrl(cardHost)}.`);
        }
      }
    };

    const toggleLocalCard = () => {
      const next = !localCard;
      if (!next) invalidatePendingPreview();
      writeLocalChipDefault(next);
      setLocalCard(next);
      if (next) {
        setStatusKind('ok');
        setStatus('Local preview is on. Your next pattern tap will connect to the card automatically.');
        return;
      }
      setStatusKind('ok');
      setStatus('Local card is off. Studio will use direct local access when the browser allows it.');
    };

    const openCardPage = () => {
      if (patternAccessRef.current !== 'ready') {
        blockPatternCardEffect(patternAccessRef.current);
        return;
      }
      if (typeof window !== 'undefined') reportCardPageOpenResult(openLocalCardPage(cardHost));
    };

    // ── color/geometry mapping for the mockup sliders ───────────────────
    const colorHex = cardColorToHex(look.customHue, look.customSaturation);
    const hueDeg = cardHueToDegrees(look.customHue);
    const satPct = Math.round((look.customSaturation / 255) * 100);
    const briPct = Math.round(look.brightness * 100);
    const spd = look.speed;
    const geo = geometryIdFromSettings(symSettings);
    const updateGeo = (id) => setSymSettings(prev => ({ ...(prev || {}), ...(GEOMETRY_SETTINGS[id] || GEOMETRY_SETTINGS.none) }));
    const patchGeo = (patch) => setSymSettings(prev => ({ ...(prev || {}), enabled: true, ...patch }));
    const fitGeo = () => {
      const points = (strips || []).flatMap(s => s.pixels || []);
      const fit = computeSymmetryFit(points, (strips || []).length);
      if (geo === 'kaleido') patchGeo({ center: fit.center, slices: fit.count });
      else if (geo === 'mandala') patchGeo({ center: fit.center, count: fit.count });
      else patchGeo({ center: fit.center });
    };

    const targetTotal = previewTargetIds.length || 1;
    const selectedTargetName = selectedTarget ? targetLabel(selectedTarget) : 'All sections';
    const showFlashAction = statusKind === 'err' && status === cardBridgeFeatureGap('frame')?.message;
    const hasPreviewFailureAction = previewAction.status === 'failed' && Boolean(previewFailure?.actionId);
    // A card fresh out of strip discovery is holding Studio's own bench config,
    // so its project fingerprint cannot match the open project and the check
    // below downgrades it to 'project' — the "somebody else's artwork is
    // installed" verdict. That warning is wrong here: Studio put that config
    // there itself, minutes ago. readCardAccessLevel re-reads the card's own
    // project evidence and upgrades exactly that case to 'bench', so trying a
    // look straight after discovery is not refused as a mismatch.
    const authorizedPatternCardAccess = readCardAccessLevel(
      patternCardAccess === 'ready' && !projectAuthorizationCurrent
        ? 'project'
        : patternCardAccess,
      cardLink?.readiness,
    );
    // Shared install precondition (src/lib/cardInstallGate.js). savePreviewToCard
    // only sets allowLayoutChange for the explicit bench test-strip override, and
    // it aborts if the card stages the write as a wiring change, so a normal
    // install from this screen cannot rewrite the physical layout and does not
    // carry the commissioning requirement.
    const installGate = evaluateCardInstallGate({
      hardwareIssue: hardwareConfigurationIssue,
      busy: cardSave.conflictsDisabled,
      cardAccess: authorizedPatternCardAccess,
    });
    const runPreviewFailureAction = () => {
      switch (previewFailure?.actionId) {
        case 'update-card':
          window.location.hash = '#screen=flash';
          break;
        case 'reconnect-card':
          openConnectionCenter();
          break;
        case 'open-card-page':
          openCardPage();
          break;
        case 'retry':
          retryLatestPreview();
          break;
        case 'recover-lights':
          void repairLed();
          break;
        default:
          break;
      }
    };

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="pm">
            {/* hero */}
            <header className="pm-hero">
              <div className="pm-title">
                <h1>Patterns &amp; Looks</h1>
                <p>Choose chip-ready patterns, tune the colors, then install the finished look on the card.</p>
                <JourneyHint step={2} nextLabel="Arrange playlist" onNext={() => go?.('playlist')} />
              </div>
              <div className="pm-actions">
                <button className="btn primary" title="Install the current look on the card" onClick={savePreviewToCard} disabled={!installGate.allowed}>{I.bolt}{cardSave.status === 'pending' ? 'Sending…' : cardSave.status === 'failed' ? 'Retry install' : 'Install on card'}</button>
                {connected &&
                  <button className="btn" title="Bring the lights back with a warm-white recovery" data-testid="recover-lights" onClick={repairLed} disabled={authorizedPatternCardAccess !== 'ready' || cardSave.conflictsDisabled}>{I.wrench}Recover lights</button>
                }
                <div className="pm-color-order">
                  <button
                    ref={colorOrderButtonRef}
                    type="button"
                    className={"btn" + (colorOrderOpen ? " toggled" : "")}
                    aria-expanded={colorOrderOpen}
                    aria-haspopup="dialog"
                    disabled={authorizedPatternCardAccess !== 'ready'}
                    onClick={async () => {
                      if (colorOrderOpen) {
                        closeColorOrder();
                        return;
                      }
                      if (currentPatternCardAccess() !== 'ready') {
                        blockPatternCardEffect(currentPatternCardAccess());
                        return;
                      }
                      try {
                        const evidence = await readCardProjectEvidence({ host: cardHost, transport: cardLink?.transport });
                        if (!matchesCurrentCardProjectEvidence(evidence)) {
                          blockPatternCardEffect('project');
                          return;
                        }
                      } catch (error) {
                        setStatusKind('err');
                        setStatus(error?.message || 'The card could not be reverified before the color test.');
                        return;
                      }
                      setMenuOpen(false);
                      setColorOrderOpen(true);
                    }}
                  >{I.refresh}Shift colors</button>
                  {colorOrderOpen &&
                    <>
                      <div className="pm-menu-backdrop" aria-hidden="true" onClick={() => closeColorOrder()} />
                      <div ref={colorOrderPopoverRef} className="pm-color-order-pop" role="dialog" aria-label="Shift colors">
                        <StripColorOrderCheck
                          quick
                          cardHost={cardHost}
                          controller={standaloneController}
                          setController={setStandaloneController}
                        />
                      </div>
                    </>
                  }
                </div>
                <div className="ag-conn">
                  <button className={"btn" + (localCard ? " toggled" : "")} aria-pressed={localCard} onClick={toggleLocalCard}>{localCard ? "Using local card" : "Use local card"}</button>
                  <button className="btn" onClick={openCardPage}>{I.open}Open card page</button>
                </div>
                <div className="pm-menu">
                  <button ref={menuButtonRef} className="btn" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => { setColorOrderOpen(false); setMenuOpen((o) => !o); }} disabled={cardSave.conflictsDisabled || Boolean(hardwareConfigurationIssue)}>{I.dots}Card tools{I.chevronD}</button>
                  {menuOpen &&
                  <>
                      <div className="pm-menu-backdrop" aria-hidden="true" onClick={() => setMenuOpen(false)} />
                      <div ref={menuRef} className="pm-menu-pop" role="menu" aria-label="Card tools">
                        <button role="menuitem" className="pm-menu-item" onClick={() => { setMenuOpen(false); repairLed(); }}>{I.wrench}Repair LED</button>
                        <button role="menuitem" className="pm-menu-item" onClick={() => { setMenuOpen(false); sendSplitPreview(); }}>{I.target}Send split preview</button>
                        <div className="pm-menu-sep" />
                        <button role="menuitem" className="pm-menu-item" onClick={() => { setMenuOpen(false); copyConfig(); }}>{I.copy}Copy setup</button>
                        <button role="menuitem" className="pm-menu-item" onClick={() => { setMenuOpen(false); downloadConfig(); }}>{I.download}Download setup</button>
                      </div>
                    </>
                  }
                </div>
              </div>
            </header>

            {status &&
              <div className={"pmx-status" + (statusKind === 'ok' ? ' is-ok' : statusKind === 'err' ? ' is-err' : '')} role={statusKind === 'err' ? 'alert' : 'status'} aria-live="polite">
                {status}
                {handoffUrl &&
                  <div className="pmx-status-actions">
                    <button type="button" className="btn primary" onClick={openCardInstaller}>Open card installer</button>
                  </div>
                }
                {showFlashAction &&
                  <div className="pmx-status-actions">
                    <button type="button" className="btn primary" onClick={() => { window.location.hash = '#screen=flash'; }}>Open Flash</button>
                  </div>
                }
                {patternCardGate &&
                  <div className="pmx-status-actions">
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => go?.(patternCardGate === 'blank' ? 'layout' : 'card')}
                    >
                      {patternCardGate === 'blank'
                        ? 'Set up LED strips and install on card'
                        : patternCardGate === 'project'
                          ? 'Verify project in Hardware'
                          : 'Recover and verify card'}
                    </button>
                  </div>
                }
                {hasPreviewFailureAction &&
                  <div className="pmx-status-actions">
                    <button type="button" className="btn primary" onClick={runPreviewFailureAction}>{previewFailure.actionLabel}</button>
                  </div>
                }
                {recoveryConfirmation === 'pending' &&
                  <div className="pmx-status-actions" aria-label="Confirm physical recovery">
                    <button type="button" className="btn primary" onClick={() => {
                      setRecoveryConfirmation('confirmed');
                      setStatusKind('ok');
                      setStatus('Warm white confirmed on the real LEDs.');
                    }}>Yes, warm white is visible</button>
                    <button type="button" className="btn" onClick={() => {
                      setRecoveryConfirmation('dark');
                      setStatusKind('err');
                      setStatus('The card responded, but physical light is not confirmed.');
                    }}>No, lights are still dark</button>
                  </div>
                }
                {recoveryConfirmation === 'dark' &&
                  <div className="pmx-status-actions">
                    <button type="button" className="btn primary" onClick={() => { window.location.hash = '#screen=layout&mode=wire'; }}>Find my LED wire</button>
                  </div>
                }
              </div>
            }

            {hardwareConfigurationIssue &&
              <div className="pmx-status is-err" role="alert" data-testid="hardware-configuration-warning">
                <strong>Hardware setup needs attention.</strong> {hardwareConfigurationIssue} Patterns are still available, but Lightweaver will not send an unsafe setup to the card.
                <div className="pmx-status-actions">
                  {canRemoveDuplicateAlternatePress &&
                    <button type="button" className="btn primary" onClick={removeDuplicateAlternatePress}>Fix automatically</button>
                  }
                  <button type="button" className="btn" onClick={() => { window.location.hash = '#screen=layout&mode=wire'; }}>Fix wiring</button>
                </div>
              </div>
            }

            <div className="pm-grid">
              {/* MAIN */}
              <section className="pm-main">
                <div className="sec-h"><span className="t">Tap a pattern to preview</span><span className="m">{filtered.length} shown of {REAL_PATTERNS.length} chip-ready + {realMixes.length} mixes / {playlistSize} in playlist</span><span className="line" /></div>

                <div className="pm-livebar">
                  <label className="pm-check">
                    <input type="checkbox" checked={livePreview} onChange={(event) => {
                      if (!event.target.checked) {
                        invalidatePendingPreview();
                        setHandoffUrl('');
                        setStatusKind('');
                        setStatus('');
                      }
                      setLivePreview(event.target.checked);
                    }} />
                    <span aria-hidden="true" className={"pm-box" + (livePreview ? " on" : "")}>{livePreview && I.check}</span>
                    Preview taps on the LED card
                  </label>
                  <span className="pm-saved" data-testid="physical-preview-status">{cardActionStatusLabel(previewAction)}</span>
                </div>

                {/* design target */}
                <div className="pm-target">
                  <div className="sec-h"><span className="t">Design target</span><span className="m">{Math.max(1, previewTargetIds.length)} section · card limit 10</span><span className="line" /></div>
                  {/* multi-section target tabs (live): All sections / Section 1 / ... */}
                  {sectionTargets.length > 1 &&
                    <div className="chips" style={{ marginBottom: 8 }} aria-label="Target sections">
                      {sectionTargets.filter(t => t.kind === 'all' || previewTargetIds.includes(t.id)).map((t) =>
                        <button key={t.id} data-testid={`section-target-${t.id}`} className={"chip" + (t.id === selectedTarget?.id ? " on" : "")} onClick={() => selectTarget(t)}>{targetLabel(t)}</button>
                      )}
                    </div>
                  }
                  <div className="pm-mixbar">
                    <div className="pm-mixlabel"><span>Layer mix</span><strong>{mixLabel}</strong></div>
                    <input className="pm-input" value={mixName} onChange={(e) => setMixName(e.target.value)} placeholder="Name this mix (optional)" aria-label="Layer mix name" />
                    <button className="btn primary" data-testid="save-current-combo" onClick={saveComboOnly}>Save look</button>
                  </div>
                  <div className="pm-targetcard">
                    <div className="tc-head">
                      <button className="tc-all on">ALL</button>
                      <div className="tc-name"><span className="lab">Target</span><strong>{selectedTargetName}</strong></div>
                      <div className="tc-total"><span className="lab">Total</span><strong>{targetTotal}</strong></div>
                      <div className="tc-pat"><span className="lab">Pattern</span><span className="tc-patval"><span className="sw" style={{ background: tint, boxShadow: `0 0 6px ${tint}` }} />{sel.label}</span></div>
                    </div>
                    <div className="tc-layer">
                      <span className="tc-num">1</span>
                      <div className="tc-name"><span className="lab">Layer</span><strong>{selectedTarget?.kind === 'section' ? targetLabel(selectedTarget) : 'Strip 1'}</strong></div>
                      <div className="tc-total"><span className="lab">LEDs</span><strong>{selectedTarget?.pixelCount || targetTotal}</strong></div>
                      <div className="tc-pat"><span className="lab">Pattern</span><span className="tc-patval"><span className="sw" style={{ background: tint, boxShadow: `0 0 6px ${tint}` }} />{sel.label}</span></div>
                    </div>
                  </div>
                </div>

                {/* browse */}
                <div className="pm-browse" style={{ margin: "5px 0px 0px" }}>
                  <div className="search" style={{ maxWidth: "none", marginBottom: 10 }}>{I.search}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chip patterns" /></div>
                  <div className="pt-tools" style={{ padding: "0px", margin: "0px 0px 10px" }}>
                    <div className="chips">
                      {PATTERN_CATS.map((c) => <button key={c.id} className={"chip" + (cat === c.id ? " on" : "")} onClick={() => setCat(c.id)}>{c.label}</button>)}
                    </div>
                    <span className="pt-count">{Math.min(visibleCount, filtered.length)} of {filtered.length} shown</span>
                  </div>
                  <div className="pm-cards">
                    {filtered.slice(0, visibleCount).map((p) => {
                      const cardInPlaylist = inPlaylist(p.id);
                      return (
                    <div key={p.id} className="pmcard-wrap">
                      <button type="button" className={"pmcard" + (p.id === selId ? " on" : "") + (cardInPlaylist ? " in-playlist" : "")} data-pattern-id={p.id} aria-pressed={p.id === selId} onClick={() => selectCard(p)}>
                        <div className="pmcard-led"><LedRow pal={p.pal} n={9} /></div>
                        <div className="pmcard-row">
                          <span className="pmcard-nm">{p.label}</span>
                          {p.mix && <span className="mixtag">mix</span>}
                          <span className="pmcard-sp">{p.sp}</span>
                        </div>
                      </button>
                        <button type="button" aria-pressed={cardInPlaylist} className={"pmcard-pl" + (cardInPlaylist ? " on" : "")} onClick={(e) => togglePl(p.id, e)}>
                          <svg viewBox="0 0 24 24" className="plstar"><path d="M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.8 6.6 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
                          {cardInPlaylist ? "In playlist" : "Add to playlist"}
                        </button>
                    </div>
                      );
                    })}
                    {!filtered.length && <p style={{ color: "var(--text-faint)", fontSize: 13, gridColumn: "1 / -1", padding: 20 }}>No chip patterns match this search.</p>}
                  </div>
                  {filtered.length > visibleCount &&
                    <div className="pm-showmore" ref={patternSentinelRef} data-testid="patterns-sentinel">
                      <button type="button" className="btn ghost-sm" data-testid="patterns-show-more" onClick={() => setVisibleCount((c) => c + PATTERN_PAGE)}>
                        Show {Math.min(PATTERN_PAGE, filtered.length - visibleCount)} more
                      </button>
                      <button type="button" className="pm-showall" data-testid="patterns-show-all" onClick={() => setVisibleCount(filtered.length)}>
                        Show all {filtered.length}
                      </button>
                    </div>
                  }
                </div>
              </section>

              {/* ASIDE */}
              <aside className="pm-aside">
                <div className="card pm-pane pm-preview-pane">
                  <div className="pm-preview-controls" aria-label="Pattern preview controls">
                    <div className="pm-preview-meta" data-testid="pattern-preview-meta" title={`${previewTargetName} · ${sel.label}`}>
                      <span className="t">Preview</span>
                      <span className="m">{sel.label}</span>
                    </div>
                    <button
                      type="button"
                      className="pm-preview-step"
                      aria-label="Previous LED target"
                      disabled={previewMode !== 'strip' || previewTargetIds.indexOf(lastPreviewTargetId) <= 0}
                      onClick={() => stepPatternPreviewTarget(-1)}
                    >‹</button>
                    <label className="pm-preview-select">
                      <span className="sr-only">Preview target</span>
                      <select
                        aria-label="Preview target"
                        value={previewMode === 'piece' ? 'piece' : lastPreviewTargetId}
                        onChange={event => choosePatternPreviewTarget(event.target.value)}
                      >
                        <option value="piece">Whole piece</option>
                        {patternPreviewSegments.map(segment => (
                          <option key={segment.id} value={segment.id}>{segment.label}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="pm-preview-step"
                      aria-label="Next LED target"
                      disabled={previewMode !== 'strip' || previewTargetIds.indexOf(lastPreviewTargetId) >= previewTargetIds.length - 1}
                      onClick={() => stepPatternPreviewTarget(1)}
                    >›</button>
                    <button
                      type="button"
                      className={`pm-piece-toggle${previewMode === 'piece' ? ' on' : ''}`}
                      aria-pressed={previewMode === 'piece'}
                      onClick={togglePatternPiecePreview}
                    >On my piece</button>
                  </div>
                  <div
                    data-testid="pattern-project-preview"
                    data-preview-led-count={projectPreviewStrip?.pts?.length || 0}
                    data-preview-order={(projectPreviewStrip?.order || []).join(',')}
                    data-preview-symmetry={symSettings?.enabled ? symSettings.type : 'none'}
                  >
                    <div
                      className="pm-piece-stage"
                      data-testid="pattern-piece-preview"
                      data-preview-mode={previewMode}
                      data-preview-target={previewMode === 'piece' ? 'piece' : lastPreviewTargetId}
                      data-preview-led-count={visiblePatternPreviewSegments.reduce((sum, segment) => sum + segment.pixels.length, 0)}
                      data-preview-view-box={patternPreviewViewBox}
                      data-preview-targets={visiblePatternPreviewSegments.map(segment => segment.id).join(',')}
                      data-preview-patterns={visiblePatternPreviewSegments.map(segment => segment.sourcePatternId).join(',')}
                    >
                      {visiblePatternPreviewSegments.length ? (
                        <PatternPreview
                          strips={visiblePatternPreviewSegments}
                          hidden={{}}
                          viewBox={patternPreviewViewBox}
                          patternId={visiblePatternPreviewSegments[0].patternId}
                          playing={true}
                          palette={visiblePatternPreviewSegments[0].palette}
                          params={patternParams?.[visiblePatternPreviewSegments[0].patternId] || {}}
                          patternParamsById={patternParams}
                          bpm={bpm}
                          masterSpeed={1}
                          masterBrightness={1}
                          masterSaturation={1}
                          masterHueShift={0}
                          gammaEnabled={gammaEnabled}
                          gammaValue={gammaValue}
                          symSettings={symSettings?.enabled ? symSettings : null}
                          glow={1.1}
                          dotSize={3}
                          motionSmoothing="soft"
                          targetFps={30}
                          ariaLabel={`${previewTargetName} animated LED preview`}
                        />
                      ) : (
                        <p className="pm-preview-empty">Add LEDs in Layout to preview this piece.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Color</span><button type="button" className="pm-save" data-testid="look-save-preset" onClick={savePreset}>Save look</button><button type="button" className="pm-reset" data-testid="look-reset" onClick={() => updatePreviewLook({ brightness: DEFAULT_CARD_VISUAL_LOOK.brightness, speed: DEFAULT_CARD_VISUAL_LOOK.speed, customHue: DEFAULT_CARD_VISUAL_LOOK.customHue, customSaturation: DEFAULT_CARD_VISUAL_LOOK.customSaturation, hueShift: DEFAULT_CARD_VISUAL_LOOK.hueShift, customBreathe: false, breatheLowerPct: 85, breatheUpperPct: 100, breatheCycleSeconds: 9, customDrift: false })}>Reset</button></div>
                  <div className="pm-palette">
                    <span className="pm-palrow">{sel.pal.map((c, i) => {
                      const h = c.replace('#', '');
                      const px = [{ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }];
                      applyLookColorModifiers(px, 0, look);
                      const cc = px[0];
                      return <span key={i} style={{ background: `rgb(${cc.r},${cc.g},${cc.b})` }} />;
                    })}</span>
                    <div className="pm-palmeta"><strong>{sel.label}</strong><span>{sel.sp} · {sel.cat.toUpperCase()}</span></div>
                  </div>

                  {/* color picker (drives the live custom hue/sat) */}
                  <div className="pm-hue">
                    <div className="pm-hue-lab"><span>Hue</span><span className="hv" data-testid="look-hue-readout">{hueDeg}°</span></div>
                    <input className="lw pm-huerange" type="range" min="0" max="255" step="1" value={look.customHue} data-testid="look-hue-slider" aria-label="Hue" onChange={(e) => updatePreviewLook({ customHue: parseInt(e.target.value) })} />
                    <input type="color" value={colorHex} data-testid="look-color-picker" aria-label="Pick color" onChange={(e) => updatePreviewLook(hexToCardColor(e.target.value, look))} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }} />
                  </div>
                  <Slider k="Saturation" v={`${satPct}%`} value={look.customSaturation} min={0} max={255} step={1} testId="look-saturation" onChange={(customSaturation) => updatePreviewLook({ customSaturation })} />
                  <Slider k="Brightness" v={`${briPct}%`} value={look.brightness} min={0.05} max={1} step={0.01} testId="look-brightness" onChange={(brightness) => updatePreviewLook({ brightness })} />
                  <Slider k="Speed" v={`${spd.toFixed(2)}×`} value={spd} min={0.05} max={3} step={0.01} testId="look-speed" onChange={(speed) => updatePreviewLook({ speed })} />

                  {/* Advanced: Breathe / Drift + Hue-shift, tucked in the mockup idiom */}
                  <details className="pmx-advanced">
                    <summary><span>Advanced</span><span className="pmx-advanced-summary" data-testid="breathe-summary">{breatheSummary}</span></summary>
                    <div className="pmx-advanced-body">
                      <div className="pmx-switches">
                        <label><input type="checkbox" checked={look.customBreathe} onChange={(e) => updatePreviewLook({ customBreathe: e.target.checked })} /> Breathe</label>
                        <label><input type="checkbox" checked={look.customDrift} onChange={(e) => updatePreviewLook({ customDrift: e.target.checked })} /> Drift</label>
                      </div>
                      {look.customBreathe && <div className="pmx-breathe-controls">
                        <Slider k="Lower brightness" v={`${look.breatheLowerPct}%`} value={look.breatheLowerPct} min={0} max={look.breatheUpperPct} step={1} testId="breathe-lower" onChange={(breatheLowerPct) => updatePreviewLook({ breatheLowerPct })} />
                        <Slider k="Upper brightness" v={`${look.breatheUpperPct}%`} value={look.breatheUpperPct} min={look.breatheLowerPct} max={100} step={1} testId="breathe-upper" onChange={(breatheUpperPct) => updatePreviewLook({ breatheUpperPct })} />
                        <Slider k="Cycle" v={`${look.breatheCycleSeconds}s`} value={look.breatheCycleSeconds} min={4} max={30} step={1} testId="breathe-cycle" onChange={(breatheCycleSeconds) => updatePreviewLook({ breatheCycleSeconds })} />
                      </div>}
                      <Slider k="Hue shift" v={String(look.hueShift)} value={look.hueShift} min={-128} max={128} step={1} testId="look-hue-shift" onChange={(hueShift) => updatePreviewLook({ hueShift })} />
                    </div>
                  </details>
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Geometry</span><span className="m">{GEOMETRY.find((g) => g.id === geo).label}</span></div>
                  <div className="geo-seg">
                    {GEOMETRY.map((g) => <button key={g.id} className={geo === g.id ? "on" : ""} onClick={() => updateGeo(g.id)}>{g.id === "mirror" && I.mirror}{g.label}</button>)}
                  </div>
                  {geo !== "none" && (
                    <>
                      <div className="pm-geo-stage">
                        <PatternPreview
                          strips={strips}
                          hidden={hidden}
                          viewBox={viewBox}
                          svgText={svgText}
                          patternId={selId}
                          playing={true}
                          palette={sel.pal}
                          params={patternParams?.[selId] || {}}
                          patternParamsById={patternParams}
                          bpm={bpm}
                          masterSpeed={look.speed}
                          masterBrightness={look.brightness}
                          masterSaturation={look.customSaturation / 255}
                          masterHueShift={look.hueShift / 255}
                          gammaEnabled={gammaEnabled}
                          gammaValue={gammaValue}
                          symSettings={symSettings?.enabled ? symSettings : null}
                          symOverlay={geo !== "none" && Boolean(symSettings?.enabled)}
                          onSymChange={patchGeo}
                          glow={1.1}
                          dotSize={3}
                          motionSmoothing="soft"
                          targetFps={30}
                        />
                      </div>
                      {geo === "mandala" && (
                        <>
                          <div className="geo-lab">Petals</div>
                          <div className="geo-seg geo-counts" aria-label="Mandala petals">
                            {[3, 4, 5, 6, 8, 12].map((c) => (
                              <button key={c} className={(symSettings.count || 8) === c ? "on" : ""} data-testid={`geo-petals-${c}`} onClick={() => patchGeo({ type: "radial", count: c })}>{c}</button>
                            ))}
                          </div>
                          <Slider k="Rotate" v={`${Math.round((symSettings.phase || 0) * 100)}%`} value={Math.round((symSettings.phase || 0) * 100)} min={0} max={100} step={1} testId="geo-rotate" onChange={(pct) => patchGeo({ type: "radial", phase: pct / 100 })} />
                        </>
                      )}
                      {geo === "kaleido" && (
                        <>
                          <Slider k="Petals" v={String(symSettings.slices || 6)} value={symSettings.slices || 6} min={2} max={16} step={1} testId="geo-slices" onChange={(s) => patchGeo({ type: "kaleido", slices: Math.round(s) })} />
                          <Slider k="Rotate" v={`${Math.round((symSettings.phase || 0) * 100)}%`} value={Math.round((symSettings.phase || 0) * 100)} min={0} max={100} step={1} testId="geo-rotate" onChange={(pct) => patchGeo({ type: "kaleido", phase: pct / 100 })} />
                        </>
                      )}
                      <div className="geo-fit">
                        <button type="button" className="geo-fit-btn" data-testid="geo-fit" onClick={fitGeo}>Fit to my piece</button>
                        <span className="geo-fit-hint">Drag the dot on the preview to move the center.</span>
                      </div>
                    </>
                  )}
                  {/* swatch grid retained as the round color picks (mockup SWATCHES) */}
                  <div className="pm-swatches" aria-label="Color swatches" style={{ marginTop: 8 }}>
                    {SWATCHES.map((sw, i) => {
                      const hue = Math.round((i / (SWATCHES.length - 1)) * 255);
                      return (
                        <button key={i} className={"pm-sw" + (Math.abs(hue - look.customHue) <= 6 ? " on" : "")} style={{ background: `oklch(72% ${cardSaturationToChroma(look.customSaturation)} ${cardHueToDegrees(hue)})` }} title={`Hue ${hue}`} aria-label={`Set hue ${hue}`} onClick={() => updatePreviewLook({ customHue: hue })} />
                      );
                    })}
                  </div>
                </div>

              </aside>
            </div>
          </div>
        </div>
      </div>);

  }

export { PatternScreen };
