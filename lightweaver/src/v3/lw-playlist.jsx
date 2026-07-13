/* Light Weaver v3 — Playlist screen */
/* Exact mockup file. The component BODY (JSX, class names, layout) is
   unchanged from the design source; only the data + handlers were swapped
   from the SAMPLE arrays to the live app's real playlist, real pattern bank,
   and real card handlers. No visual structure was altered. */
import React, { useMemo, useState } from 'react';
import { I } from './lw-shared.jsx';
import { useProject } from '../state/ProjectContext.jsx';
import { REAL_PATTERN_BY_ID, adaptPattern, adaptSavedLook } from './v3-data.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import { DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import { normalizeSavedLooks } from '../lib/sectionLookModel.js';
import { normalizeCardVisualLook } from '../lib/cardVisualLook.js';
import {
  applyTestStripToRuntimePackage,
  readTestStrip,
  TEST_STRIP_ZONE_ID,
} from '../lib/testStrip.js';
import {
  buildPatternPlaylistPreview,
  buildSavedLookPlaylistPreviewTargets,
} from '../lib/playlistLivePreview.js';
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
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import {
  ensureCardSectionsForPreview,
  syncRuntimePackageToCard,
} from '../lib/cardSectionSync.js';
import {
  pushLivePreviewToCard,
  pushSectionPreviewToCard,
  resetLiveOutputOnCard,
} from '../lib/cardLiveControl.js';
import {
  makePlaylistPushErrorState,
  makePlaylistPushPendingState,
  makePlaylistPushSuccessState,
} from '../lib/studioActionStatus.js';

function downloadJson(filename, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Test strip mode: the bench strip's output layout basically never matches
// whatever the card is already carrying (the real design, or a different
// bench length), so every live preview reshapes the card to the collapsed
// single zone first — with the wiring/project guard deliberately overridden,
// since the user is intentionally testing on a different physical strip.
// Cheap no-op when the card already has that zone (ensureCardSectionsForPreview
// only pushes when it's missing).
async function ensureTestStripLayoutOnCard(host, runtimePackage, length) {
  const testPackage = applyTestStripToRuntimePackage(runtimePackage, length);
  await ensureCardSectionsForPreview({
    host,
    requiredZoneIds: [TEST_STRIP_ZONE_ID],
    runtimePackage: testPackage,
    allowLayoutChange: true,
    allowProjectChange: true,
  });
  return testPackage;
}

// Adapt one real pattern id into the mockup pattern shape ({id,label,grad,...}).
// The .pl-art box in the exact JSX paints a single gradient, so we hand it grad.
function realPatternShape(patternId) {
  return REAL_PATTERN_BY_ID.get(patternId) || adaptPattern(patternId);
}

  function PlaylistScreen({ connected }) {
    const {
      projectId,
      projectName,
      strips,
      patchBoard,
      standaloneController,
      setStandaloneController,
    } = useProject();

    const [host, setHost] = useState(readStoredCardHost);
    // Tracks the row last pushed live so the mockup's .is-live highlight stays
    // faithful. The real engine still pushes the preview to the card.
    const [live, setLive] = useState(null);
    const [handoffUrl, setHandoffUrl] = useState('');
    const [playlistStatus, setPlaylistStatus] = useState(null);
    const [playlistSyncing, setPlaylistSyncing] = useState(false);
    const previewSequence = React.useRef(0);
    const [drag, setDrag] = useState({ from: null, over: null });

    const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
    const savedLooks = normalizeSavedLooks(standaloneController?.looks);
    const savedLookById = new Map(savedLooks.map((look) => [look.id, look]));

    const rawPlaylist = isImplicitDefaultPatternPlaylist(standaloneController?.playlist)
      ? []
      : standaloneController?.playlist;
    const playlist = normalizeCardPlaylist(rawPlaylist, { savedLooks, allowEmpty: true });

    const runtimePackage = useMemo(
      () => buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: board, standaloneController }),
      [projectId, projectName, strips, board, standaloneController],
    );
    const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
    const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

    // ── live playlist write-back to the standalone controller ─────────────
    const writePlaylist = (nextItems) => {
      const normalized = normalizeCardPlaylist(nextItems, { savedLooks, allowEmpty: true });
      setStandaloneController((prev) => {
        const current = prev || {};
        return {
          ...current,
          playlist: normalized,
          controls: {
            ...(current.controls || {}),
            encoder: {
              ...(current.controls?.encoder || {}),
              patternCycleIds: derivePlaylistLookIds(normalized),
            },
          },
        };
      });
    };

    const moveTo = (fromIndex, toIndex) => {
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= playlist.length || toIndex >= playlist.length) return;
      const next = [...playlist];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      writePlaylist(next);
    };

    const move = (i, d) => moveTo(i, i + d);

    const first = (i) => {
      if (i <= 0) return;
      const next = [...playlist];
      const [item] = next.splice(i, 1);
      next.unshift(item);
      writePlaylist(next);
    };

    const dup = (i) => {
      const item = playlist[i];
      if (!item) return;
      const clone = { ...item, id: `${item.id}-copy-${Date.now()}`, createdAt: Date.now() };
      const next = [...playlist];
      next.splice(i + 1, 0, clone);
      writePlaylist(next);
    };

    const remove = (i) => writePlaylist(playlist.filter((_, k) => k !== i));

    // ── live preview / card control ───────────────────────────────────────
    const previewPatternOnCard = async (patternId) => {
      const sequence = ++previewSequence.current;
      setHandoffUrl('');
      try {
        const testStrip = readTestStrip();
        if (testStrip.enabled) {
          await ensureTestStripLayoutOnCard(host, runtimePackage, testStrip.length);
          if (sequence !== previewSequence.current) return;
        }
        await pushLivePreviewToCard(buildPatternPlaylistPreview(patternId), { host, timeoutMs: 2200 });
        if (sequence === previewSequence.current) { setPlaylistStatus(null); return true; }
      } catch { /* preview is best-effort; connection state lives in the footer */ }
      return false;
    };

    const previewSavedLookOnCard = async (savedLook) => {
      if (!savedLook) return;
      const sequence = ++previewSequence.current;
      setHandoffUrl('');
      try {
        const testStrip = readTestStrip();
        if (testStrip.enabled) {
          // A saved mix is normally several section targets across the real
          // design's zones; a bench strip is one zone, so just play the
          // mix's own default look across the whole (collapsed) strip.
          await ensureTestStripLayoutOnCard(host, runtimePackage, testStrip.length);
          if (sequence !== previewSequence.current) return;
          await pushLivePreviewToCard(
            { ...normalizeCardVisualLook(savedLook.defaultLook || {}), syncZones: true },
            { host, timeoutMs: 2600 },
          );
          if (sequence === previewSequence.current) { setPlaylistStatus(null); return true; }
          return false;
        }
        const targets = buildSavedLookPlaylistPreviewTargets({ savedLook, strips, patchBoard: board });
        const requiredZoneIds = targets
          .filter(target => target.kind === 'section')
          .map(target => String(target.zoneId || target.id || ''))
          .filter(Boolean);
        await ensureCardSectionsForPreview({
          host,
          requiredZoneIds,
          runtimePackage,
        });
        if (sequence !== previewSequence.current) return;
        await pushSectionPreviewToCard(
          targets,
          { host, timeoutMs: 2600 },
        );
        if (sequence === previewSequence.current) { setPlaylistStatus(null); return true; }
      } catch (error) {
        if (sequence !== previewSequence.current || error?.reason === 'superseded') return;
        const nextStatus = makePlaylistPushErrorState(error, { host, runtimePackage });
        setPlaylistStatus(nextStatus);
        setHandoffUrl(nextStatus.handoffUrl || '');
      }
      return false;
    };

    const setLiveItem = async (item) => {
      if (!item) return;
      const confirmed = item.type === 'combo'
        ? await previewSavedLookOnCard(savedLookById.get(item.lookId))
        : await previewPatternOnCard(item.patternId);
      if (confirmed) setLive(item.id);
    };

    const fallbackLiveLook = () => {
      const firstItem = playlist[0];
      if (firstItem?.type === 'combo') {
        const savedLook = savedLookById.get(firstItem.lookId);
        return savedLook?.defaultLook || standaloneController?.defaultLook || {};
      }
      if (firstItem?.patternId) return buildPatternPlaylistPreview(firstItem.patternId);
      return standaloneController?.defaultLook || {};
    };

    const resetLiveOutput = async () => {
      setHandoffUrl('');
      try {
        const testStrip = readTestStrip();
        if (testStrip.enabled) await ensureTestStripLayoutOnCard(host, runtimePackage, testStrip.length);
        await resetLiveOutputOnCard(fallbackLiveLook(), { host, timeoutMs: 3000 });
        setLive(null);
      } catch { /* best-effort */ }
    };

    const loadPlaylistToCard = async ({ allowLayoutChange = false, allowProjectChange = false } = {}) => {
      previewSequence.current += 1;
      setHandoffUrl('');
      setPlaylistStatus(makePlaylistPushPendingState());
      setPlaylistSyncing(true);
      // Test strip mode is a deliberate, session-only override: everything
      // pushed to the card targets the collapsed single N-LED output, and the
      // wiring/project guard is bypassed on purpose (the user knows they're on
      // a bench strip). The saved project (playlist/zones/patchBoard) is
      // never touched — only what's sent to the card.
      const testStrip = readTestStrip();
      const packageForCard = testStrip.enabled
        ? applyTestStripToRuntimePackage(runtimePackage, testStrip.length)
        : runtimePackage;
      try {
        const response = await syncRuntimePackageToCard({
          host,
          runtimePackage: packageForCard,
          allowLayoutChange: testStrip.enabled ? true : allowLayoutChange,
          allowProjectChange: testStrip.enabled ? true : allowProjectChange,
        });
        setPlaylistStatus(makePlaylistPushSuccessState(response));
      } catch (error) {
        const nextStatus = makePlaylistPushErrorState(error, { host, runtimePackage: packageForCard });
        setPlaylistStatus(nextStatus);
        setHandoffUrl(nextStatus.handoffUrl || '');
      } finally {
        setPlaylistSyncing(false);
      }
    };

    const copyConfig = async () => {
      try { await navigator.clipboard.writeText(configJson); } catch { /* clipboard blocked */ }
    };

    const downloadConfig = () => downloadJson(`${safeProjectName || 'lightweaver'}-playlist-config.json`, configJson);
    const openCard = () => window.open(cardHostToUrl(host), '_blank');
    // "Adjust" on the wiring-mismatch banner: jump straight to Layout → Size,
    // where the per-strip LED counts live, so the user can change the number
    // instead of accepting the card's current wiring. Deep-linked via the hash
    // the layout screen already parses (#screen=layout&mode=size).
    const adjustLedCounts = () => { window.location.hash = 'screen=layout&mode=size'; };

    const persistHost = (value) => { setHost(value); writeStoredCardHost(value); };

    // ── add from the real banks ───────────────────────────────────────────
    const addPattern = (patternId) => {
      if (playlistContainsPattern(playlist, patternId)) { void previewPatternOnCard(patternId); return; }
      const item = makePatternPlaylistItem(patternId);
      if (!item) return;
      writePlaylist([...playlist, item]);
      void previewPatternOnCard(patternId);
    };

    const addCombo = (savedLook) => {
      if (playlistContainsCombo(playlist, savedLook.id)) { void previewSavedLookOnCard(savedLook); return; }
      const item = makeComboPlaylistItem(savedLook);
      if (!item) return;
      writePlaylist([...playlist, item]);
      void previewSavedLookOnCard(savedLook);
    };

    // ── drag + drop (attached to the existing .pl-row, no new elements) ────
    const startDrag = (event, index) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(index));
      setDrag({ from: index, over: index });
    };
    const hoverDrop = (event, index) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDrag((cur) => (cur.over === index ? cur : { ...cur, over: index }));
    };
    const dropItem = (event, index) => {
      event.preventDefault();
      const transferIndex = Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
      const fromIndex = Number.isFinite(transferIndex) ? transferIndex : drag.from;
      setDrag({ from: null, over: null });
      moveTo(fromIndex, index);
    };
    const endDrag = () => setDrag({ from: null, over: null });

    // ── derived view data (real banks, mockup shapes) ─────────────────────
    // Mixes pool: real saved looks adapted to the mockup mix shape.
    const mixShapes = savedLooks.map((look) => ({ ...adaptSavedLook(look), id: look.id, label: look.label || look.name || 'Saved mix' }));
    // Pattern pool: real bank minus whatever is already in the playlist.
    const pool = DEFAULT_CARD_PATTERN_BANK
      .filter((p) => !playlistContainsPattern(playlist, p.id))
      .map((p) => realPatternShape(p.id));
    const mixesRemaining = savedLooks.some((look) => !playlistContainsCombo(playlist, look.id));

    return (
      <div className="screen">
        <div className="screen-scroll">
          <div className="pm">
            <header className="pm-hero">
              <div className="pm-title">
                <h1>Playlist</h1>
                <p>The order the dial press cycles through on the card. The first look starts on boot.</p>
              </div>
              <div className="pm-actions">
                <button className="btn" onClick={resetLiveOutput}>{I.refresh}Reset live</button>
                <button className="btn primary" disabled={!connected || playlistSyncing} onClick={() => loadPlaylistToCard()}>
                  {I.bolt}{playlistSyncing ? 'Loading…' : 'Load playlist to card'}
                </button>
                <div className="pm-menu">
                  <button className="btn" onClick={copyConfig}>{I.copy}Copy chip config</button>
                </div>
                <button className="btn" onClick={downloadConfig}>{I.download}Download</button>
                <button className="btn" onClick={openCard}>{I.open}Open card page</button>
              </div>
            </header>

            {playlistStatus &&
              <div
                className={"pmx-status" + (playlistStatus.kind === 'ok' ? ' is-ok' : playlistStatus.kind === 'err' ? ' is-err' : '')}
                data-testid="playlist-card-status"
                role={playlistStatus.kind === 'err' ? 'alert' : 'status'}
                aria-live="polite"
              >
                {playlistStatus.message}
                {playlistStatus.action?.hint &&
                  <div className="pmx-status-hint">{playlistStatus.action.hint}</div>
                }
                <div className="pmx-status-actions">
                  {playlistStatus.action &&
                    <button
                      className="btn primary"
                      disabled={playlistSyncing}
                      onClick={() => loadPlaylistToCard({
                        allowLayoutChange: playlistStatus.action.kind === 'allow-layout-change',
                        allowProjectChange: playlistStatus.action.kind === 'allow-project-change',
                      })}
                    >
                      {playlistSyncing ? 'Loading…' : playlistStatus.action.label}
                    </button>
                  }
                  {playlistStatus.action?.kind === 'allow-layout-change' &&
                    <button className="btn" disabled={playlistSyncing} onClick={adjustLedCounts}>Adjust LED count</button>
                  }
                  <button className="btn" onClick={openCard}>{I.open}Open card page</button>
                  {handoffUrl &&
                    <a className="btn primary" href={handoffUrl} target="_blank" rel="noopener noreferrer">Open card installer</a>
                  }
                </div>
              </div>
            }

            <div className="pm-grid">
              <section className="pm-main">
                <div className="pl-hostrow">
                  <span className="sf-l">Card address</span>
                  <input className="pm-input" value={host} onChange={(e) => persistHost(e.target.value)} style={{ maxWidth: 260 }} aria-label="Card address" />
                  <span className="pl-count">{playlist.length} looks · dial press to advance</span>
                </div>

                <div className="pl-list">
                  {playlist.map((item, i) => {
                    const savedLook = item.type === 'combo' ? savedLookById.get(item.lookId) : null;
                    const p = item.type === 'combo'
                      ? { ...adaptSavedLook(savedLook), label: item.label }
                      : realPatternShape(item.patternId);
                    if (!p) return null;
                    const id = item.id;
                    return (
                      <article
                        key={id}
                        className={"pl-row" + (live === id ? " is-live" : "")}
                        data-testid={`playlist-row-${id}`}
                        draggable
                        onDragStart={(e) => startDrag(e, i)}
                        onDragOver={(e) => hoverDrop(e, i)}
                        onDrop={(e) => dropItem(e, i)}
                        onDragEnd={endDrag}
                      >
                        <div className="pl-index">
                          <span className="pl-grip">::</span>
                          <strong>{String(i + 1).padStart(2, "0")}</strong>
                          <span>{i === 0 ? "startup" : "press"}</span>
                        </div>
                        <span className="pl-art" style={{ background: p.grad }} />
                        <div className="pl-copy">
                          <strong>{item.label}{item.type === 'combo' && <span className="mixtag">mix</span>}</strong>
                          <span>{item.type === 'combo' ? "section mix" : `${p.label} across the piece`}</span>
                        </div>
                        <div className="pl-actions">
                          <button className={"plbtn" + (live === id ? " on" : "")} aria-pressed={live === id} onClick={() => setLiveItem(item)}>Live</button>
                          <button className="plbtn" disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
                          <button className="plbtn" disabled={i === playlist.length - 1} onClick={() => move(i, 1)}>Down</button>
                          <button className="plbtn" disabled={i === 0} onClick={() => first(i)}>Make first</button>
                          <button className="plbtn" onClick={() => dup(i)}>Copy</button>
                          <button className="plbtn danger" onClick={() => remove(i)}>Remove</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              <aside className="pm-aside">
                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Layer mixes</span><span className="m">{mixShapes.length}</span></div>
                  {mixShapes.map((m) => {
                    const added = playlistContainsCombo(playlist, m.id);
                    return (
                      <button key={m.id} className="pl-source" onClick={() => addCombo(savedLookById.get(m.id))} disabled={added}>
                        <span className="pl-src-art" style={{ background: m.grad }} />
                        <span className="pl-src-nm">{m.label}<span className="mixtag">mix</span></span>
                        <span className="pl-src-add">{added ? I.check : I.plus}</span>
                      </button>
                    );
                  })}
                  {!mixShapes.length && <p className="pl-empty">All mixes added. Save more on Patterns.</p>}
                  {mixShapes.length > 0 && !mixesRemaining && <p className="pl-empty">All mixes added. Save more on Patterns.</p>}
                </div>

                <div className="card pm-pane">
                  <div className="sec-h"><span className="t">Pattern pool</span><span className="m">{pool.length} available</span></div>
                  <div className="pl-pool">
                    {pool.map((p) => (
                      <button key={p.id} className="pl-chip" onClick={() => addPattern(p.id)} title={`Add ${p.label}`}>
                        <span className="pl-chip-art" style={{ background: p.grad }} />
                        <span className="pl-chip-nm">{p.label}</span>
                        <span className="pl-chip-add">{I.plus}</span>
                      </button>
                    ))}
                    {!pool.length && <p className="pl-empty">Every pattern is in the playlist.</p>}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    );
  }

export { PlaylistScreen };
