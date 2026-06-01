import { useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { buildCardRuntimePackageFromProject } from '../lib/cardRuntimeProject.js';
import { DEFAULT_CARD_CONTROLS, DEFAULT_CARD_PATTERN_BANK } from '../lib/cardRuntimeContract.js';
import { getCardPatternById, getCardPatternFingerprint } from '../lib/cardPatternBank.js';
import { normalizePatchBoard } from '../lib/patchBoard.js';
import { normalizeCardVisualLook } from '../lib/cardVisualLook.js';
import { normalizeSavedLooks } from '../lib/sectionLookModel.js';
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
  cardHostToUrl,
  readStoredCardHost,
  writeStoredCardHost,
} from '../lib/cardConnection.js';
import { buildCardConfigHandoffUrl, pushConfigToCard } from '../lib/cardPushClient.js';

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
    <section className="lw-playlist-section">
      <div className="lw-sec-header">
        <span>{title}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function PatternThumb({ patternId, label }) {
  const pattern = getCardPatternById(patternId);
  const fingerprint = getCardPatternFingerprint(patternId);
  return (
    <span
      className={`lw-playlist-thumb ${fingerprint.cssClass}`}
      style={{
        '--thumb-bg': pattern?.preview,
        '--palette-a': fingerprint.palette[0],
        '--palette-b': fingerprint.palette[1],
        '--palette-c': fingerprint.palette[2],
      }}
      aria-label={label || pattern?.label || patternId}
    />
  );
}

function ComboThumbs({ savedLook }) {
  const lookIds = Object.values(savedLook?.sectionLooks || {})
    .map(look => normalizeCardVisualLook(look).patternId);
  const patternIds = lookIds.length
    ? lookIds
    : [normalizeCardVisualLook(savedLook?.defaultLook).patternId];
  return (
    <span className="lw-playlist-combo-thumbs" aria-hidden="true">
      {patternIds.slice(0, 4).map((patternId, index) => (
        <PatternThumb key={`${patternId}-${index}`} patternId={patternId}/>
      ))}
      {patternIds.length > 4 && <span className="lw-playlist-thumb-more">+{patternIds.length - 4}</span>}
    </span>
  );
}

function PlaylistRow({
  item,
  index,
  count,
  savedLook,
  onMove,
  onFirst,
  onDuplicate,
  onRemove,
}) {
  const pattern = item.type === 'pattern' ? getCardPatternById(item.patternId) : null;
  const sectionCount = savedLook ? Object.keys(savedLook.sectionLooks || {}).length || 1 : 1;
  return (
    <article className="lw-playlist-row" data-testid={`playlist-row-${item.id}`}>
      <div className="lw-playlist-index">
        <strong>{String(index + 1).padStart(2, '0')}</strong>
        <span>{index === 0 ? 'startup' : 'knob'}</span>
      </div>
      <div className="lw-playlist-art">
        {item.type === 'combo'
          ? <ComboThumbs savedLook={savedLook}/>
          : <PatternThumb patternId={item.patternId} label={item.label}/>}
      </div>
      <div className="lw-playlist-row-copy">
        <strong>{item.label}</strong>
        <span>
          {item.type === 'combo'
            ? `${sectionCount} section combo`
            : `${pattern?.label || item.patternId} across the piece`}
        </span>
      </div>
      <div className="lw-playlist-row-actions">
        <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => onMove(index, -1)}>Up</button>
        <button type="button" className="btn btn-ghost" disabled={index === count - 1} onClick={() => onMove(index, 1)}>Down</button>
        <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => onFirst(index)}>Make first</button>
        <button type="button" className="btn btn-ghost" onClick={() => onDuplicate(index)}>Copy</button>
        <button type="button" className="btn btn-ghost" disabled={count <= 1} onClick={() => onRemove(index)}>Remove</button>
      </div>
    </article>
  );
}

export function PlaylistScreen() {
  const {
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

  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const savedLooks = normalizeSavedLooks(standaloneController?.looks);
  const savedLookById = new Map(savedLooks.map(look => [look.id, look]));
  const defaultLook = normalizeCardVisualLook(standaloneController?.defaultLook);
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
      defaultLook.patternId,
      ...(Array.isArray(controls.encoder.patternCycleIds) ? controls.encoder.patternCycleIds : []),
    ],
  });
  const runtimePackage = useMemo(
    () => buildCardRuntimePackageFromProject({ projectName, strips, patchBoard: board, standaloneController }),
    [projectName, strips, board, standaloneController],
  );
  const configJson = useMemo(() => JSON.stringify(runtimePackage.config, null, 2), [runtimePackage]);
  const safeProjectName = (projectName || 'lightweaver-piece').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  const playlistSummary = playlistLabels(playlist, 4).join(', ');

  const writePlaylist = (nextItems, message = '') => {
    const normalized = normalizeCardPlaylist(nextItems, {
      savedLooks,
      fallbackPatternIds: [defaultLook.patternId],
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
    const next = [...playlist];
    const [item] = next.splice(index, 1);
    next.splice(nextIndex, 0, item);
    writePlaylist(next);
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
    if (playlist.length <= 1) return;
    const item = playlist[index];
    const next = playlist.filter((_, itemIndex) => itemIndex !== index);
    writePlaylist(next, `${item?.label || 'Look'} removed from the playlist.`);
  };

  const addPattern = (patternId) => {
    if (playlistContainsPattern(playlist, patternId)) {
      setStatusKind('');
      setStatus(`${getCardPatternById(patternId)?.label || patternId} is already in the playlist. Use Copy on the row if you need it twice.`);
      return;
    }
    const item = makePatternPlaylistItem(patternId);
    if (!item) return;
    writePlaylist([...playlist, item], `${item.label} added to the playlist.`);
  };

  const addCombo = (savedLook) => {
    if (playlistContainsCombo(playlist, savedLook.id)) {
      setStatusKind('');
      setStatus(`${savedLook.label} is already in the playlist. Use Copy on the row if you need it twice.`);
      return;
    }
    const item = makeComboPlaylistItem(savedLook);
    if (!item) return;
    writePlaylist([...playlist, item], `${item.label} added to the playlist.`);
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

  return (
    <div className="lw-playlist-screen">
      <div className="lw-patterns-shell lw-playlist-shell">
        <header className="lw-patterns-hero">
          <div>
            <h1>Playlist</h1>
            <p>Choose exactly what lives on the card. The knob cycles this list from top to bottom.</p>
          </div>
          <div className="lw-patterns-actions">
            <button type="button" className="btn btn-primary" onClick={loadPlaylistToCard}>Load playlist to card</button>
            <button type="button" className="btn btn-primary" onClick={copyConfig}>Copy chip config</button>
            <button type="button" className="btn" onClick={() => downloadJson(`${safeProjectName || 'lightweaver'}-playlist-config.json`, configJson)}>Download</button>
            <button type="button" className="btn btn-ghost" onClick={() => window.open(cardHostToUrl(cardHost), '_blank')}>Open card</button>
          </div>
        </header>

        {status && (
          <div className={`lw-chip-status ${statusKind === 'ok' ? 'is-ok' : statusKind === 'err' ? 'is-err' : ''}`}>
            {status}
            {handoffUrl && (
              <a className="btn btn-primary" href={handoffUrl} target="_blank" rel="noopener noreferrer">
                Open card installer
              </a>
            )}
          </div>
        )}

        <div className="lw-playlist-grid">
          <Section title="Knob order" meta={`${playlist.length} looks · ${playlistSummary || 'empty'}`}>
            <div className="lw-playlist-host-row">
              <span>Card address</span>
              <input
                className="lw-search-input"
                value={cardHost}
                onChange={event => persistHost(event.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="lightweaver.local"
              />
            </div>
            <div className="lw-playlist-list">
              {playlist.map((item, index) => (
                <PlaylistRow
                  key={item.id}
                  item={item}
                  index={index}
                  count={playlist.length}
                  savedLook={item.type === 'combo' ? savedLookById.get(item.lookId) : null}
                  onMove={moveItem}
                  onFirst={makeFirst}
                  onDuplicate={duplicateItem}
                  onRemove={removeItem}
                />
              ))}
            </div>
          </Section>

          <aside className="lw-playlist-sources">
            <Section title="Add patterns" meta={`${DEFAULT_CARD_PATTERN_BANK.length} chip-ready`}>
              <div className="lw-playlist-pattern-pool">
                {DEFAULT_CARD_PATTERN_BANK.map(pattern => (
                  <button
                    key={pattern.id}
                    type="button"
                    className={playlistContainsPattern(playlist, pattern.id) ? 'is-added' : ''}
                    onClick={() => addPattern(pattern.id)}
                  >
                    <PatternThumb patternId={pattern.id}/>
                    <span>
                      <strong>{pattern.label}</strong>
                      <em>{playlistContainsPattern(playlist, pattern.id) ? 'In playlist' : 'Add to playlist'}</em>
                    </span>
                  </button>
                ))}
              </div>
            </Section>

            <Section title="Add combos" meta={`${savedLooks.length} saved`}>
              {savedLooks.length ? (
                <div className="lw-playlist-combo-pool">
                  {savedLooks.map(savedLook => (
                    <button
                      key={savedLook.id}
                      type="button"
                      className={playlistContainsCombo(playlist, savedLook.id) ? 'is-added' : ''}
                      onClick={() => addCombo(savedLook)}
                    >
                      <ComboThumbs savedLook={savedLook}/>
                      <span>
                        <strong>{savedLook.label}</strong>
                        <em>{playlistContainsCombo(playlist, savedLook.id) ? 'In playlist' : 'Add combo'}</em>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="lw-playlist-empty">Save an Outer and Inner combo on Patterns, then add it here.</p>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </div>
  );
}
