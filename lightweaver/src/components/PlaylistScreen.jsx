import { useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { getCardPatternById } from '../lib/cardPatternBank.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import { normalizeCardVisualLook } from '../lib/cardVisualLook.js';
import { normalizeSavedLooks } from '../lib/sectionLookModel.js';
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
  playlistLabels,
} from '../lib/cardPlaylist.js';
import {
  cardHostToUrl,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardConfigHandoffUrl, pushConfigToCard } from '../lib/cardPushClient.js';
import { pushLivePreviewToCard, pushSectionPreviewToCard, resetLiveOutputOnCard } from '../lib/cardLiveControl.js';

// Inline icons matching the v3 mockup's shared icon set (lw-shared.jsx I.*).
// Same SVG paths so the header and sidebar glyphs render identical to the mock.
const I = {
  refresh: <svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-1.5 5.5"/><path d="M20 5v5h-5"/></svg>,
  bolt: <svg viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>,
  copy: <svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>,
  download: <svg viewBox="0 0 24 24"><path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>,
  open: <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>,
  check: <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 6"/></svg>,
  plus: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>,
};

function downloadJson(filename, content) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Pattern thumbnail. The mock's .pl-art is a single 44x30 gradient box; the live
// engine has a real gradient per pattern (pattern.preview), so we feed that in.
function PatternArt({ patternId }) {
  const pattern = getCardPatternById(patternId);
  return <span className="pl-art" style={{ background: pattern?.preview || 'var(--bg-elev)' }} />;
}

// Combos show multiple section thumbnails. The mock has no combo art style, so
// the slices live in v3-playlist-extra.css (mock idiom) and reuse .pl-art sizing.
function ComboArt({ savedLook }) {
  const lookIds = Object.values(savedLook?.sectionLooks || {})
    .map(look => normalizeCardVisualLook(look).patternId);
  const patternIds = lookIds.length
    ? lookIds
    : [normalizeCardVisualLook(savedLook?.defaultLook).patternId];
  const shown = patternIds.slice(0, 4);
  return (
    <span className="pl-art pl-art-combo" aria-hidden="true">
      {shown.map((patternId, index) => {
        const pattern = getCardPatternById(patternId);
        return (
          <span
            key={`${patternId}-${index}`}
            className="pl-art-slice"
            style={{ background: pattern?.preview || 'var(--bg-elev)' }}
          />
        );
      })}
    </span>
  );
}

export function PlaylistScreen() {
  const {
    projectId,
    projectName,
    strips,
    patchBoard,
    standaloneController,
    setStandaloneController,
  } = useProject();
  const [cardHost, setCardHost] = useState(readStoredCardHost);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');
  const [handoffUrl, setHandoffUrl] = useState('');
  const [dragState, setDragState] = useState({ fromIndex: null, overIndex: null });
  // Tracks the row last sent live so the mock's .is-live highlight + "Live on" chip
  // stay faithful. The real engine still pushes the preview to the card.
  const [liveId, setLiveId] = useState(null);

  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const savedLookById = new Map(savedLooks.map(look => [look.id, look]));
  const rawPlaylist = isImplicitDefaultPatternPlaylist(standaloneController?.playlist)
    ? []
    : standaloneController?.playlist;
  const playlist = normalizeCardPlaylist(rawPlaylist, {
    savedLooks,
    allowEmpty: true,
  });
  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectId, projectName, strips, patchBoard: board, standaloneController }),
    [projectId, projectName, strips, board, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const playlistSummary = playlistLabels(playlist, 4).join(', ');

  const patternPool = DEFAULT_CARD_PATTERN_BANK.filter(pattern => !playlistContainsPattern(playlist, pattern.id));

  const writePlaylist = (nextItems, message = '') => {
    const normalized = normalizeCardPlaylist(nextItems, {
      savedLooks,
      allowEmpty: true,
    });
    setStandaloneController(prev => {
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
    if (message) {
      setStatusKind('ok');
      setStatus(message);
    }
  };

  const moveItem = (index, delta) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= playlist.length) return;
    moveItemToIndex(index, nextIndex);
  };

  const moveItemToIndex = (fromIndex, toIndex, message = '') => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= playlist.length || toIndex >= playlist.length) return;
    const next = [...playlist];
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    writePlaylist(next, message);
  };

  const makeFirst = (index) => {
    if (index <= 0) return;
    const next = [...playlist];
    const [item] = next.splice(index, 1);
    next.unshift(item);
    writePlaylist(next, `${item.label} will start first on the card.`);
  };

  const duplicateItem = (index) => {
    const item = playlist[index];
    if (!item) return;
    const clone = { ...item, id: `${item.id}-copy-${Date.now()}`, createdAt: Date.now() };
    const next = [...playlist];
    next.splice(index + 1, 0, clone);
    writePlaylist(next, `${item.label} copied in the playlist.`);
  };

  const removeItem = (index) => {
    const item = playlist[index];
    const next = playlist.filter((_, itemIndex) => itemIndex !== index);
    writePlaylist(next, `${item?.label || 'Look'} removed from the playlist.`);
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

  const previewPatternOnCard = async (patternId, label = '') => {
    const previewLabel = label || getCardPatternById(patternId)?.label || patternId;
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Previewing ${previewLabel} live on ${cardHostToUrl(cardHost)}...`);
    try {
      await pushLivePreviewToCard(
        buildPatternPlaylistPreview(patternId),
        { host: cardHost, timeoutMs: 2200 },
      );
      setStatusKind('ok');
      setStatus(`${previewLabel} is live on the card. Load playlist to keep this knob order.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? error.message
        : `Could not preview ${previewLabel} on ${cardHostToUrl(cardHost)}.`);
    }
  };

  const previewSavedLookOnCard = async (savedLook) => {
    if (!savedLook) return;
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Previewing ${savedLook.label} live on ${cardHostToUrl(cardHost)}...`);
    try {
      await pushSectionPreviewToCard(
        buildSavedLookPlaylistPreviewTargets({ savedLook, strips, patchBoard: board }),
        { host: cardHost, timeoutMs: 2600 },
      );
      setStatusKind('ok');
      setStatus(`${savedLook.label} is live on the card. Load playlist to keep this knob order.`);
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? error.message
        : `Could not preview ${savedLook.label} on ${cardHostToUrl(cardHost)}.`);
    }
  };

  const previewPlaylistItem = (item) => {
    if (!item) return;
    setLiveId(item.id);
    if (item.type === 'combo') {
      void previewSavedLookOnCard(savedLookById.get(item.lookId));
      return;
    }
    void previewPatternOnCard(item.patternId, item.label);
  };

  const resetLiveOutput = async () => {
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Resetting live output on ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await resetLiveOutputOnCard(fallbackLiveLook(), {
        host: cardHost,
        timeoutMs: 3000,
      });
      setLiveId(null);
      setStatusKind('ok');
      setStatus(response.source === 'zones'
        ? `Live output reset from the card's current ${response.zonesPreviewed || 1} zone${response.zonesPreviewed === 1 ? '' : 's'}.`
        : 'Live output reset from the first saved playlist look.');
    } catch (error) {
      setStatusKind('err');
      setStatus(error?.reason === 'mixed-content'
        ? error.message
        : `Could not reset live output on ${cardHostToUrl(cardHost)}.`);
    }
  };

  const startPlaylistDrag = (event, index) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    setDragState({ fromIndex: index, overIndex: index });
  };

  const hoverPlaylistDrop = (event, index) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragState(current => (
      current.overIndex === index ? current : { ...current, overIndex: index }
    ));
  };

  const dropPlaylistItem = (event, index) => {
    event.preventDefault();
    const transferIndex = Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
    const fromIndex = Number.isFinite(transferIndex) ? transferIndex : dragState.fromIndex;
    const item = playlist[fromIndex];
    setDragState({ fromIndex: null, overIndex: null });
    if (!item) return;
    moveItemToIndex(fromIndex, index, `${item.label} moved to button-press position ${index + 1}.`);
  };

  const endPlaylistDrag = () => {
    setDragState({ fromIndex: null, overIndex: null });
  };

  const addPattern = (patternId) => {
    const label = getCardPatternById(patternId)?.label || patternId;
    if (playlistContainsPattern(playlist, patternId)) {
      void previewPatternOnCard(patternId, label);
      return;
    }
    const item = makePatternPlaylistItem(patternId);
    if (!item) return;
    writePlaylist([...playlist, item], `${item.label} added to the playlist.`);
    void previewPatternOnCard(patternId, item.label);
  };

  const addCombo = (savedLook) => {
    if (playlistContainsCombo(playlist, savedLook.id)) {
      void previewSavedLookOnCard(savedLook);
      return;
    }
    const item = makeComboPlaylistItem(savedLook);
    if (!item) return;
    writePlaylist([...playlist, item], `${item.label} added to the playlist.`);
    void previewSavedLookOnCard(savedLook);
  };

  const persistHost = (value) => {
    setCardHost(value);
    writeStoredCardHost(value);
  };

  const loadPlaylistToCard = async () => {
    setHandoffUrl('');
    setStatusKind('');
    setStatus(`Loading playlist to ${cardHostToUrl(cardHost)}...`);
    try {
      const response = await pushConfigToCard(runtimePackage, { host: cardHost, timeoutMs: 6000, reboot: 'if-needed' });
      setStatusKind('ok');
      setStatus(response.rebooting
        ? 'Playlist loaded. The card is rebooting so the knob order takes effect.'
        : 'Playlist loaded. The knob now follows this order.');
    } catch (error) {
      setStatusKind('err');
      if (error?.reason === 'mixed-content') {
        setHandoffUrl(buildCardConfigHandoffUrl(cardHost, runtimePackage));
        setStatus('The browser blocked direct local-card access from this public page. Open the card installer to save this playlist on the card.');
      } else if (error?.reason === 'layout-mismatch' || error?.reason === 'project-mismatch') {
        setStatus(error.message);
      } else {
        setStatus(`Could not load the playlist to the card at ${cardHostToUrl(cardHost)}.`);
      }
    }
  };

  const copyConfig = async () => {
    setHandoffUrl('');
    try {
      await navigator.clipboard.writeText(configJson);
      setStatusKind('ok');
      setStatus('Playlist chip config copied.');
    } catch {
      setStatusKind('err');
      setStatus('Clipboard was blocked. Download the chip config instead.');
    }
  };

  const downloadConfig = () => {
    downloadJson(`${safeProjectName || 'lightweaver'}-playlist-config.json`, configJson);
  };

  const openCard = () => {
    window.open(cardHostToUrl(cardHost), '_blank');
  };

  const mixesRemaining = savedLooks.some(look => !playlistContainsCombo(playlist, look.id));

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
              <button type="button" className="btn" onClick={resetLiveOutput}>{I.refresh}Reset live</button>
              <button type="button" className="btn primary" onClick={loadPlaylistToCard}>{I.bolt}Load playlist to card</button>
              <div className="pm-menu">
                <button type="button" className="btn" onClick={copyConfig}>{I.copy}Copy chip config</button>
              </div>
              <button type="button" className="btn" onClick={downloadConfig}>{I.download}Download</button>
              <button type="button" className="btn" onClick={openCard}>{I.open}Open card</button>
            </div>
          </header>

          {status && (
            <div className={`pl-status${statusKind === 'ok' ? ' is-ok' : statusKind === 'err' ? ' is-err' : ''}`}>
              <span>{status}</span>
              {handoffUrl && (
                <a className="btn primary" href={handoffUrl} target="_blank" rel="noopener noreferrer">
                  {I.open}Open card installer
                </a>
              )}
            </div>
          )}

          <div className="pm-grid">
            <section className="pm-main">
              <div className="pl-hostrow">
                <span className="sf-l">Card address</span>
                <input
                  className="pm-input"
                  value={cardHost}
                  onChange={event => persistHost(event.target.value)}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="lightweaver.local"
                  style={{ maxWidth: 260 }}
                />
                <span className="pl-count">{playlist.length} looks · {playlistSummary || 'empty'}</span>
              </div>

              <div className="pl-list">
                {playlist.map((item, index) => {
                  const isLive = liveId === item.id;
                  const isDragging = dragState.fromIndex === index;
                  const isDropTarget = dragState.overIndex === index && dragState.fromIndex !== index;
                  const savedLook = item.type === 'combo' ? savedLookById.get(item.lookId) : null;
                  const pattern = item.type === 'pattern' ? getCardPatternById(item.patternId) : null;
                  const sectionCount = savedLook ? Object.keys(savedLook.sectionLooks || {}).length || 1 : 1;
                  return (
                    <article
                      key={item.id}
                      className={`pl-row${isLive ? ' is-live' : ''}${isDragging ? ' is-dragging' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
                      data-testid={`playlist-row-${item.id}`}
                      draggable
                      aria-grabbed={isDragging}
                      onDragStart={event => startPlaylistDrag(event, index)}
                      onDragOver={event => hoverPlaylistDrop(event, index)}
                      onDrop={event => dropPlaylistItem(event, index)}
                      onDragEnd={endPlaylistDrag}
                    >
                      <div className="pl-index">
                        <span className="pl-grip" aria-label={`Drag ${item.label}`}>::</span>
                        <strong>{String(index + 1).padStart(2, '0')}</strong>
                        <span>{index === 0 ? 'startup' : 'press'}</span>
                      </div>
                      {item.type === 'combo'
                        ? <ComboArt savedLook={savedLook} />
                        : <PatternArt patternId={item.patternId} />}
                      <div className="pl-copy">
                        <strong>{item.label}{item.type === 'combo' && <span className="mixtag">mix</span>}</strong>
                        <span>
                          {item.type === 'combo'
                            ? `${sectionCount} section mix`
                            : `${pattern?.label || item.patternId} across the piece`}
                        </span>
                      </div>
                      <div className="pl-actions">
                        <button type="button" className={`plbtn${isLive ? ' on' : ''}`} onClick={() => previewPlaylistItem(item)}>Live</button>
                        <button type="button" className="plbtn" disabled={index === 0} onClick={() => moveItem(index, -1)}>Up</button>
                        <button type="button" className="plbtn" disabled={index === playlist.length - 1} onClick={() => moveItem(index, 1)}>Down</button>
                        <button type="button" className="plbtn" disabled={index === 0} onClick={() => makeFirst(index)}>Make first</button>
                        <button type="button" className="plbtn" onClick={() => duplicateItem(index)}>Copy</button>
                        <button type="button" className="plbtn danger" onClick={() => removeItem(index)}>Remove</button>
                      </div>
                    </article>
                  );
                })}
                {!playlist.length && <p className="pl-empty">The playlist is empty. Add patterns or mixes from the right.</p>}
              </div>
            </section>

            <aside className="pm-aside">
              <div className="card pm-pane">
                <div className="sec-h"><span className="t">Layer mixes</span><span className="m">{savedLooks.length}</span></div>
                {savedLooks.map(savedLook => {
                  const added = playlistContainsCombo(playlist, savedLook.id);
                  return (
                    <button
                      key={savedLook.id}
                      type="button"
                      className="pl-source"
                      onClick={() => addCombo(savedLook)}
                      disabled={added}
                    >
                      <ComboArt savedLook={savedLook} />
                      <span className="pl-src-nm">{savedLook.label}<span className="mixtag">mix</span></span>
                      <span className="pl-src-add">{added ? I.check : I.plus}</span>
                    </button>
                  );
                })}
                {!savedLooks.length && <p className="pl-empty">Save an Outer and Inner mix on Patterns, then add it here.</p>}
                {savedLooks.length > 0 && !mixesRemaining && <p className="pl-empty">All mixes added. Save more on Patterns.</p>}
              </div>

              <div className="card pm-pane">
                <div className="sec-h"><span className="t">Pattern pool</span><span className="m">{patternPool.length} available</span></div>
                <div className="pl-pool">
                  {patternPool.map(pattern => (
                    <button
                      key={pattern.id}
                      type="button"
                      data-pattern-id={pattern.id}
                      className="pl-chip"
                      onClick={() => addPattern(pattern.id)}
                      title={`Add ${pattern.label}`}
                    >
                      <span className="pl-chip-art" style={{ background: pattern.preview || 'var(--bg-elev)' }} />
                      <span className="pl-chip-nm">{pattern.label}</span>
                      <span className="pl-chip-add">{I.plus}</span>
                    </button>
                  ))}
                  {!patternPool.length && <p className="pl-empty">Every pattern is in the playlist.</p>}
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
