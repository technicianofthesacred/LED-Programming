/* Light Weaver v3 — Patterns & Mixes (faithful to v3, cleaned + recolored) */
/* Exact mockup file, converted from window-global script to ES module.
   The visual body (helpers + JSX structure + class names) is the mockup's own.
   Only data + handlers are real now: the SAMPLE bank/mixes/local useState that
   drove the mockup are replaced with the live pattern bank, ProjectContext, and
   the real handlers ported from the old PatternsScreen. No visual markup, class
   names, or LED-render helpers changed. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { I, PATTERN_CATS, STRIP_TESTS, SWATCHES, GEOMETRY } from './lw-shared.jsx';
import { REAL_PATTERNS, REAL_PATTERN_BY_ID, adaptPattern, adaptSavedLook, defaultWarmPatternId } from './v3-data.js';
import { useProject } from '../state/ProjectContext.jsx';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import {
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
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { buildCardConfigHandoffUrl, pushConfigToCard } from '../lib/cardPushClient.js';
import {
  previewResponseUsedZoneFallback,
  pushLiveHardwareToCard,
  pushLivePreviewToCard,
  recoverCardLights,
} from '../lib/cardLiveControl.js';
import { COLOR_ORDERS, normalizeUsbLedColorOrder } from '../lib/usbLedColorOrder.js';
import {
  readLocalChipDefault,
  writeLocalChipDefault,
  openCardBridge,
} from '../lib/cardBridge.js';

  // Maps the mockup's 4 strip-test ids (r/g/b/w) to the live STRIP_COLOR_TESTS.
  const STRIP_TEST_TO_PATTERN = { r: 'test-red', g: 'test-green', b: 'test-blue', w: 'test-white' };
  const STRIP_TEST_BRIGHTNESS = { r: 1, g: 1, b: 1, w: 0.55 };
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
  function LedStage({ pal }) {
    return (
      <div className="pm-led-stage">
        <LedRow pal={pal} n={22} big wave />
        <span className="sheen" />
      </div>);
  }

  function PatternScreen({ connected }) {
    const {
      projectId,
      projectName,
      projectRevision,
      strips,
      setStrips,
      viewBox,
      svgText,
      patchBoard,
      setPatchBoard,
      standaloneController,
      setStandaloneController,
      registerProjectSnapshotContributor,
      symSettings,
      setSymSettings,
    } = useProject();

    // ── browse / ui state ───────────────────────────────────────────────
    const [q, setQ] = useState("");
    const [cat, setCat] = useState("all");
    const [livePreview, setLivePreview] = useState(true);
    const [localCard, setLocalCard] = useState(readLocalChipDefault);
    const [stripTest, setStripTest] = useState(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [mixName, setMixName] = useState("");

    // ── real engine state ───────────────────────────────────────────────
    const [cardHost, setCardHost] = useState(readStoredCardHost);
    const [status, setStatus] = useState("");
    const [statusKind, setStatusKind] = useState("");
    const [handoffUrl, setHandoffUrl] = useState("");
    // True when the last live push fell back from a section to the whole strip
    // because the card has no matching zone. Never silent: it renders the
    // "Send sections to card" banner until sections reach the card.
    const [zoneFallback, setZoneFallback] = useState(false);
    const [selectedTargetId, setSelectedTargetId] = useState(ALL_SECTIONS_TARGET_ID);
    const [draftLooks, setDraftLooks] = useState({});
    const livePreviewTimer = useRef(null);
    const livePreviewSeq = useRef(0);
    const savedComboSeq = useRef(0);
    const draftProjectSnapshotRef = useRef(project => project);

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
      getCardPatternById(savedDefaultPatternId) &&
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

    const sectionTargets = useMemo(
      () => deriveSectionTargets({ strips, patchBoard: board, defaultLook: savedGlobalLook }),
      [
        strips, board,
        savedGlobalLook.patternId, savedGlobalLook.brightness, savedGlobalLook.speed,
        savedGlobalLook.hueShift, savedGlobalLook.customHue, savedGlobalLook.customSaturation,
        savedGlobalLook.customBreathe, savedGlobalLook.customDrift,
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

    const stripColorOrder = normalizeUsbLedColorOrder(standaloneController?.led?.colorOrder || 'RGB');
    const rawPlaylist = isImplicitDefaultPatternPlaylist(standaloneController?.playlist)
      ? []
      : standaloneController?.playlist;
    const playlist = normalizeCardPlaylist(rawPlaylist, { savedLooks, allowEmpty: true });

    // ── adapted (real) pattern bank + saved mixes in the mockup's shape ──
    const realMixes = useMemo(
      () => savedLooks.map(adaptSavedLook).filter(Boolean),
      [savedLooks],
    );
    const ALL = useMemo(() => [...realMixes, ...REAL_PATTERNS], [realMixes]);
    // Map an adapted mix-card id back to its real saved look (adaptSavedLook
    // sets the card id to look.id when present, else `mix-${patternId}`).
    const findSavedLook = useCallback(
      (cardId) => savedLooks.find(l => (l.id || `mix-${l.patternId}`) === cardId),
      [savedLooks],
    );
    // The selected pattern is driven by the live look.patternId.
    const selId = look.patternId;
    const sel = REAL_PATTERN_BY_ID.get(selId) || adaptPattern(selId) || ALL[0];
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
    const playlistSize = playlist.length;

    // ── controller / preview helpers (ported from PatternsScreen) ───────
    const runtimePackage = useMemo(
      () => buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: board, standaloneController }),
      [projectId, projectName, strips, board, standaloneController],
    );
    const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
    const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

    const updateController = (patch) => {
      setStandaloneController(prev => {
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

    const scheduleLivePreview = useCallback((nextLook, target = selectedTarget, delayMs = 80) => {
      if (!livePreview) {
        // Never silently do nothing: say why the lights are not following.
        setStatusKind('');
        setStatus('Live preview is off, so the lights stayed as they were. Turn on "Preview taps on the LED card" above to see changes on the piece.');
        return;
      }
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
            // Surface (never swallow) a section push that collapsed to the
            // whole strip — the banner stays up until sections reach the card.
            setZoneFallback(zone ? previewResponseUsedZoneFallback(response) : false);
            setStatusKind('ok');
            const patternLabel = getCardPatternById(nextLook.patternId)?.label || nextLook.patternId;
            setStatus(previewResponseUsedZoneFallback(response)
              ? `Previewing ${patternLabel} on the whole piece — the card doesn't have ${targetLabel(target)} as its own section yet.`
              : `Previewing ${patternLabel} on ${targetLabel(target)}. Not saved yet.`);
          }
        } catch (error) {
          if (error?.reason === 'superseded') {
            // An older send was replaced by a newer one — say so briefly
            // instead of staying silent; the newest send reports its own result.
            setStatusKind('');
            setStatus('Skipped an older preview — sending your latest change.');
            return;
          }
          if (sequence === livePreviewSeq.current) {
            setStatusKind('err');
            setStatus(error?.reason === 'mixed-content'
              ? error.message
              : `Could not reach the card at ${cardHostToUrl(cardHost)} — this change is not on the lights. Use Connect to card in the bottom bar.`);
          }
        }
      }, delayMs);
    }, [cardHost, livePreview, selectedTarget]);

    useEffect(() => () => {
      if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
    }, []);

    useEffect(() => {
      if (sectionTargets.some(target => target.id === selectedTargetId)) return;
      setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    }, [sectionTargets, selectedTargetId]);

    useEffect(() => {
      setDraftLooks({});
      setMixName('');
      setSelectedTargetId(ALL_SECTIONS_TARGET_ID);
    }, [projectRevision]);

    const updatePreviewLook = (patch, { push = true } = {}) => {
      if (!selectedTarget) return;
      const nextLook = normalizeSectionVisualLook({ ...look, ...patch });
      setDraftLooks(prev => ({ ...prev, [selectedTarget.id]: nextLook }));
      if (push) scheduleLivePreview(nextLook, selectedTarget);
    };

    // Clicking a target tab pushes that target's current look to its zone
    // (debounced) so the physical strip follows the selection.
    const selectTarget = (target) => {
      if (!target) return;
      setSelectedTargetId(target.id);
      if (livePreview && !connected) {
        setStatusKind('err');
        setStatus(`Not connected to the card, so the lights can't follow this selection. Use Connect to card in the bottom bar.`);
        return;
      }
      scheduleLivePreview(resolveDraftTargetLook(target), target, 150);
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

    draftProjectSnapshotRef.current = (project) => {
      if (!Object.keys(draftLooks).length) return project;
      const { nextBoard, nextController } = buildCurrentHardwareState();
      return {
        ...project,
        layout: { ...(project.layout || {}), patchBoard: nextBoard },
        devices: { ...(project.devices || {}), standaloneController: nextController },
      };
    };
    useEffect(() => {
      if (!registerProjectSnapshotContributor) return undefined;
      return registerProjectSnapshotContributor((project) => draftProjectSnapshotRef.current(project));
    }, [registerProjectSnapshotContributor]);

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
      const { nextLook, nextBoard, nextController: savedController } = buildCurrentHardwareState({ saveNamedLook: true });
      const nextController = promotePatternFirst(savedController, nextLook.patternId);
      const nextPackage = buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: nextBoard, standaloneController: nextController });
      setHandoffUrl('');
      setStatusKind('');
      setStatus(`Saving ${getCardPatternById(nextLook.patternId)?.label || nextLook.patternId} to ${cardHostToUrl(cardHost)}...`);
      try {
        const safety = await checkCardLayoutWriteSafety(nextPackage, 'saving');
        if (!safety.ok) return;
        setPatchBoard(nextBoard);
        setStandaloneController(nextController);
        setDraftLooks({});
        setMixName('');
        const response = await pushConfigToCard(nextPackage, { host: safety.host || cardHost, timeoutMs: 6000, reboot: 'if-needed' });
        // The saved config carries the section zones, so the card has them now.
        setZoneFallback(false);
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
        } else if (error?.reason === 'layout-mismatch' || error?.reason === 'project-mismatch') {
          setStatusKind('err');
          setStatus(error.message);
        } else {
          setStatusKind('err');
          setStatus('Saved in the Studio, but could not reach the card. Copy or download the setup JSON and paste it on the card page.');
        }
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
      setStatusKind('ok');
      setStatus(`${saved?.label || 'Layer mix'} saved to the pattern bank.`);
    };

    const playStripColorTest = async (testId, colorOrder = stripColorOrder) => {
      const patternId = STRIP_TEST_TO_PATTERN[testId] || 'test-red';
      const brightness = STRIP_TEST_BRIGHTNESS[testId] ?? 1;
      const test = STRIP_TESTS.find(t => t.id === testId) || STRIP_TESTS[0];
      setStripTest(testId);
      setStatusKind('');
      setStatus(`Showing ${test.label} test on ${cardHostToUrl(cardHost)} with ${colorOrder} order...`);
      try {
        await recoverCardLights({ patternId, brightness, syncZones: true }, { host: cardHost, timeoutMs: 3200 });
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
        await playStripColorTest(stripTest || 'r', appliedOrder);
        setStatusKind('ok');
        setStatus(`${appliedOrder} order is live. Stop when the strip shows the test color.`);
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

    const writePlaylist = (nextItems, message = '') => {
      const normalized = normalizeCardPlaylist(nextItems, { savedLooks, allowEmpty: true });
      updateController({
        playlist: normalized,
        controls: { encoder: { patternCycleIds: derivePlaylistLookIds(normalized) } },
      });
      if (message) { setStatusKind('ok'); setStatus(message); }
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
          scheduleLivePreview(normalizeSectionVisualLook(realLook.defaultLook), sectionTargets[0]);
        }
        return;
      }
      updatePreviewLook({ patternId: p.id });
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

    const downloadConfig = () => {
      const blob = new Blob([configJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeProjectName || 'lightweaver'}-chip-config.json`;
      a.click();
      URL.revokeObjectURL(url);
    };

    const repairLed = async () => {
      if (livePreviewTimer.current) clearTimeout(livePreviewTimer.current);
      const sequence = ++livePreviewSeq.current;
      setHandoffUrl('');
      setStatusKind('');
      setStatus(`Sending warm-white LED repair to ${cardHostToUrl(cardHost)}...`);
      try {
        await recoverCardLights({ patternId: 'warm-white', brightness: 1, syncZones: true }, { host: cardHost, timeoutMs: 3200 });
        if (sequence !== livePreviewSeq.current) return;
        setStatusKind('ok');
        setStatus('Warm-white recovery sent. If you see light, the strip is alive; otherwise check power, ground, and the data pin.');
      } catch (error) {
        if (sequence !== livePreviewSeq.current) return;
        setStatusKind('err');
        setStatus(error?.message || `LED repair could not reach ${cardHostToUrl(cardHost)}. Check power and WiFi, then turn on Use local card.`);
      }
    };

    const sendSplitPreview = async () => {
      const { nextLook, nextBoard, nextController } = buildCurrentHardwareState();
      const nextPackage = buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: nextBoard, standaloneController: nextController });
      setHandoffUrl('');
      setStatusKind('');
      setStatus(`Applying split preview to ${cardHostToUrl(cardHost)}...`);
      try {
        const safety = await checkCardLayoutWriteSafety(nextPackage, 'applying split preview');
        if (!safety.ok) return;
        const response = await pushConfigToCard(nextPackage, { host: safety.host || cardHost, timeoutMs: 6000, reboot: 'if-needed', allowLayoutChange: true });
        setPatchBoard(nextBoard);
        setStandaloneController(nextController);
        setDraftLooks({});
        setZoneFallback(false);
        if (response.rebooting) {
          setStatusKind('ok');
          setStatus('Split preview was saved. The card is rebooting now so the LED output layout takes effect.');
          return;
        }
        const zone = selectedTarget?.kind === 'section' ? selectedTarget.zoneId || selectedTarget.id : '';
        await pushLivePreviewToCard({ ...nextLook, zone }, { host: safety.host || cardHost, timeoutMs: 2200 }).catch(() => null);
        setStatusKind('ok');
        setStatus('Split preview is live on the card. Section taps now target each section separately.');
      } catch (error) {
        if (error?.reason === 'mixed-content') {
          offerCardHandoff(nextPackage, 'The browser blocked direct local-card access from this public page. Open the card installer to apply this split on the card.');
        } else {
          setStatusKind('err');
          setStatus(error?.message || `Could not apply split preview to the card at ${cardHostToUrl(cardHost)}.`);
        }
      }
    };

    const toggleLocalCard = () => {
      const next = !localCard;
      writeLocalChipDefault(next);
      setLocalCard(next);
      if (next) {
        const opened = openCardBridge(cardHost, {
          autoOpenStudio: true,
          studioUrl: typeof window !== 'undefined' ? window.location.href : '',
        });
        if (opened) {
          setStatusKind('');
          setStatus(`Local card is now the default control path. Opening ${cardHostToUrl(cardHost)} so Studio can take over the LEDs there.`);
        } else {
          setStatusKind('err');
          setStatus(`Could not open ${cardHostToUrl(cardHost)}. Allow popups or open the card from the Card status.`);
        }
        return;
      }
      setStatusKind('ok');
      setStatus('Local card is off. Studio will use direct local access when the browser allows it.');
    };

    const openCardPage = () => {
      if (typeof window !== 'undefined') window.open(cardHostToUrl(cardHost), '_blank');
    };

    // ── color/geometry mapping for the mockup sliders ───────────────────
    const colorHex = cardColorToHex(look.customHue, look.customSaturation);
    const hueDeg = cardHueToDegrees(look.customHue);
    const satPct = Math.round((look.customSaturation / 255) * 100);
    const briPct = Math.round(look.brightness * 100);
    const spd = look.speed;
    const geo = geometryIdFromSettings(symSettings);
    const updateGeo = (id) => setSymSettings(prev => ({ ...(prev || {}), ...(GEOMETRY_SETTINGS[id] || GEOMETRY_SETTINGS.none) }));

    const targetTotal = Math.max(0, sectionTargets.length - 1) || 1;
    const selectedTargetName = selectedTarget ? targetLabel(selectedTarget) : 'All sections';

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="pm">
            {/* hero */}
            <header className="pm-hero">
              <div className="pm-title">
                <h1>Patterns &amp; Mixes</h1>
                <p>Choose chip-ready patterns, tune the colors, then save section blends as layer mixes for the card.</p>
              </div>
              <div className="pm-actions">
                <button className="btn primary" title="Save the current look to the card" onClick={savePreviewToCard}>{I.bolt}Save to card</button>
                {connected &&
                  <button className="btn" title="Bring the lights back with a warm-white recovery" data-testid="recover-lights" onClick={repairLed}>{I.wrench}Recover lights</button>
                }
                <div className="ag-conn">
                  <button className={"btn" + (localCard ? " toggled" : "")} aria-pressed={localCard} onClick={toggleLocalCard}>{localCard ? "Using local card" : "Use local card"}</button>
                  <button className="btn" onClick={openCardPage}>{I.open}Open card page</button>
                </div>
                <div className="pm-menu">
                  <button className="btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>{I.dots}Card tools{I.chevronD}</button>
                  {menuOpen &&
                  <>
                      <div className="pm-menu-backdrop" onClick={() => setMenuOpen(false)} />
                      <div className="pm-menu-pop">
                        <button className="pm-menu-item" onClick={() => { setMenuOpen(false); repairLed(); }}>{I.wrench}Repair LED</button>
                        <button className="pm-menu-item" onClick={() => { setMenuOpen(false); sendSplitPreview(); }}>{I.target}Send split preview</button>
                        <div className="pm-menu-sep" />
                        <button className="pm-menu-item" onClick={() => { setMenuOpen(false); copyConfig(); }}>{I.copy}Copy setup</button>
                        <button className="pm-menu-item" onClick={() => { setMenuOpen(false); downloadConfig(); }}>{I.download}Download setup</button>
                      </div>
                    </>
                  }
                </div>
              </div>
            </header>

            {status &&
              <div className={"pmx-status" + (statusKind === 'ok' ? ' is-ok' : statusKind === 'err' ? ' is-err' : '')}>
                {status}
                {handoffUrl &&
                  <div className="pmx-status-actions">
                    <a className="btn primary" href={handoffUrl} target="_blank" rel="noopener noreferrer">Open card installer</a>
                  </div>
                }
              </div>
            }

            {/* Section pushes must never quietly collapse to the whole strip:
                this banner stays up until the card actually has the sections. */}
            {zoneFallback &&
              <div className="pmx-status is-err" data-testid="zone-fallback-banner">
                Card doesn't have sections yet — for now the whole strip shows every look.
                <div className="pmx-status-actions">
                  <button className="btn primary" onClick={sendSplitPreview}>Send sections to card</button>
                </div>
              </div>
            }

            <div className="pm-grid">
              {/* MAIN */}
              <section className="pm-main">
                <div className="sec-h"><span className="t">Tap a pattern to preview</span><span className="m">{filtered.length} shown of {REAL_PATTERNS.length} chip-ready + {realMixes.length} mixes / {playlistSize} in playlist</span><span className="line" /></div>

                <div className="pm-livebar">
                  <label className="pm-check" onClick={() => setLivePreview((v) => !v)}>
                    <span className={"pm-box" + (livePreview ? " on" : "")}>{livePreview && I.check}</span>
                    Preview taps on the LED card
                  </label>
                  <span className="pm-saved">All sections saved</span>
                </div>

                <div className="pm-stripfinder">
                  <span className="sf-l">Strip finder</span>
                  <div className="sf-btns">
                    {STRIP_TESTS.map((t) =>
                    <button key={t.id} className={"sf-btn" + (stripTest === t.id ? " on" : "")} title={`Test ${t.label}`} onClick={() => playStripColorTest(t.id)} style={stripTest === t.id ? { "--sf": t.col } : null}>{t.short}</button>
                    )}
                  </div>
                  <span className="sf-order">Order <b data-testid="strip-color-order">{stripColorOrder}</b></span>
                  <button className="btn ghost-sm" onClick={tryNextStripColorOrder}>{I.refresh}Try next order</button>
                </div>

                {/* design target */}
                <div className="pm-target">
                  <div className="sec-h"><span className="t">Design target</span><span className="m">{Math.max(1, sectionTargets.length - 1)} section · card limit 10</span><span className="line" /></div>
                  {/* multi-section target tabs (live): All sections / Section 1 / ... */}
                  {sectionTargets.length > 1 &&
                    <div className="chips" style={{ marginBottom: 8 }} aria-label="Target sections">
                      {sectionTargets.map((t) =>
                        <button key={t.id} data-testid={`section-target-${t.id}`} className={"chip" + (t.id === selectedTarget?.id ? " on" : "")} onClick={() => selectTarget(t)}>{targetLabel(t)}</button>
                      )}
                    </div>
                  }
                  <div className="pm-mixbar">
                    <div className="pm-mixlabel"><span>Layer mix</span><strong>{mixLabel}</strong></div>
                    <input className="pm-input" value={mixName} onChange={(e) => setMixName(e.target.value)} placeholder="Name this mix (optional)" aria-label="Layer mix name" />
                    <button className="btn primary" data-testid="save-current-combo" onClick={saveComboOnly}>Save mix</button>
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
                    <span className="pt-count">{filtered.length} of {REAL_PATTERNS.length} shown</span>
                  </div>
                  <div className="pm-cards">
                    {filtered.map((p) =>
                    <div key={p.id} className={"pmcard" + (p.id === selId ? " on" : "")} data-pattern-id={p.id} onClick={() => selectCard(p)}>
                        <div className="pmcard-led"><LedRow pal={p.pal} n={9} /></div>
                        <div className="pmcard-row">
                          <span className="pmcard-nm">{p.label}</span>
                          {p.mix && <span className="mixtag">mix</span>}
                          <span className="pmcard-sp">{p.sp}</span>
                        </div>
                        <button className={"pmcard-pl" + (inPlaylist(p.id) ? " on" : "")} onClick={(e) => togglePl(p.id, e)}>
                          <svg viewBox="0 0 24 24" className="plstar"><path d="M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.8 6.6 19.4l1.2-6L3.4 9.3l6-.7z" /></svg>
                          {inPlaylist(p.id) ? "In playlist" : "Add to playlist"}
                        </button>
                      </div>
                    )}
                    {!filtered.length && <p style={{ color: "var(--text-faint)", fontSize: 13, gridColumn: "1 / -1", padding: 20 }}>No chip patterns match this search.</p>}
                  </div>
                </div>
              </section>

              {/* ASIDE */}
              <aside className="pm-aside">
                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Preview</span><span className="m">{selectedTargetName} · {sel.label}</span></div>
                  <LedStage pal={sel.pal} />
                  <p className="pt-desc">{sel.desc}</p>
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Color &amp; motion</span><span className="m">{selectedTargetName}</span></div>
                  <div className="pm-motion"><Strand tint={tint} /></div>
                  <div className="pm-palette">
                    <span className="pm-palrow">{sel.pal.map((c, i) => <span key={i} style={{ background: c }} />)}</span>
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
                    <summary>Advanced</summary>
                    <div className="pmx-advanced-body">
                      <div className="pmx-switches">
                        <label><input type="checkbox" checked={look.customBreathe} onChange={(e) => updatePreviewLook({ customBreathe: e.target.checked })} /> Breathe</label>
                        <label><input type="checkbox" checked={look.customDrift} onChange={(e) => updatePreviewLook({ customDrift: e.target.checked })} /> Drift</label>
                      </div>
                      <Slider k="Hue shift" v={String(look.hueShift)} value={look.hueShift} min={-128} max={128} step={1} testId="look-hue-shift" onChange={(hueShift) => updatePreviewLook({ hueShift })} />
                    </div>
                  </details>
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Geometry</span><span className="m">{GEOMETRY.find((g) => g.id === geo).label}</span></div>
                  <div className="geo-seg">
                    {GEOMETRY.map((g) => <button key={g.id} className={geo === g.id ? "on" : ""} onClick={() => updateGeo(g.id)}>{g.id === "mirror" && I.mirror}{g.label}</button>)}
                  </div>
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

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Card</span><span className="m">{runtimePackage.config.led.pixels} pixels</span></div>
                  <div className="pmx-cardsummary">
                    <span>Live preview</span><strong data-testid="card-live-preview-label">{sel.label}</strong>
                    <span>Editing</span><strong data-testid="card-target-label">{selectedTargetName}</strong>
                    <span>Starts with</span><strong data-testid="card-startup-label">{getCardPatternById(savedGlobalLook.patternId)?.label || savedGlobalLook.patternId}</strong>
                    <span>Playlist</span><strong data-testid="card-knob-cycle-label">{derivePlaylistLookIds(playlist).join(', ')}</strong>
                    <div className="pmx-cardhost">
                      <input className="pm-input" value={cardHost} onChange={(e) => { setCardHost(e.target.value); writeStoredCardHost(e.target.value); }} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="lightweaver.local" aria-label="Card local page host" />
                      <button className="btn ghost-sm" onClick={openCardPage}>Open</button>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>);

  }

export { PatternScreen };
