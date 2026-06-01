import { useEffect, useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  addOffPatch,
  cutsForStrip,
  expandPatchBoard,
  mainChain,
  movePatch,
  normalizePatchBoard,
  sliceStripIntoPatchesPreservingRoute,
  updatePatchRange,
} from '../lib/patchBoard.js';
import {
  makeCardRuntimePackage,
  patchBoardToZones,
} from '../lib/cardRuntimeContract.js';
import {
  getCardHostname,
  setCardHostname,
  pushConfigToCard,
  CardPushError,
} from '../lib/cardPushClient.js';

function patchLength(patch) {
  if (patch.source?.type === 'off') return Math.max(0, Math.trunc(patch.source.ledCount || 0));
  const start = Number(patch.source?.startLed);
  const end = Number(patch.source?.endLed);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.abs(Math.trunc(end) - Math.trunc(start)) + 1;
}

function friendlyName(value) {
  return (value || 'Source path')
    .replace(/_/g, ' ')
    .replace(/\s*:\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function patchDirection(patch) {
  if (patch.source?.type === 'off') return '';
  return Number(patch.source.startLed) <= Number(patch.source.endLed) ? '->' : '<-';
}

export function PatchBoardScreen({
  embedded = false,
  wireOverlayMode = 'idle',
  selectedWireCut = null,
  onNudgeSelectedCut,
  onDeleteSelectedCut,
  onClearSelectedCut,
}) {
  const { strips, patchBoard, setPatchBoard, projectId, projectName, standaloneController } = useProject();
  const [pushHost, setPushHost] = useState(() => getCardHostname());
  const [pushStatus, setPushStatus] = useState('');
  const [pushKind, setPushKind] = useState(''); // '' | 'ok' | 'err' | 'pending'
  const [pushFallbackJson, setPushFallbackJson] = useState('');
  const [activeStripId, setActiveStripId] = useState(() => strips[0]?.id || null);
  const [selectedPatchId, setSelectedPatchId] = useState(null);
  const [offCount, setOffCount] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (!strips.some(strip => strip.id === activeStripId)) {
      setActiveStripId(strips[0]?.id || null);
    }
  }, [activeStripId, strips]);

  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const expanded = useMemo(() => expandPatchBoard(board, strips), [board, strips]);
  const chain = mainChain(board);
  const activeStrip = useMemo(
    () => strips.find(strip => strip.id === activeStripId) || strips[0] || null,
    [activeStripId, strips],
  );
  const patchesById = useMemo(() => new Map(board.patches.map(patch => [patch.id, patch])), [board.patches]);
  const rowsByPatchId = useMemo(() => new Map(expanded.rows.map(row => [row.patchId, row])), [expanded.rows]);
  const orderedPatches = chain.rowIds.map(id => patchesById.get(id)).filter(Boolean);
  const activeStripPatches = orderedPatches.filter(
    patch => patch.source?.type === 'strip' && patch.source.stripId === activeStrip?.id,
  );
  const selectedPatch = patchesById.get(selectedPatchId) || activeStripPatches[0] || orderedPatches[0] || null;
  const activeCuts = activeStrip ? cutsForStrip(board, activeStrip.id) : [];

  const updateBoard = (mutate) => {
    setPatchBoard(prev => {
      const next = normalizePatchBoard(prev, strips);
      mutate(next);
      return normalizePatchBoard(next, strips);
    });
  };

  const reversePatch = (patch) => {
    if (!patch || patch.source?.type !== 'strip') return;
    updateBoard(next => updatePatchRange(next, patch.id, patch.source.endLed, patch.source.startLed));
  };

  const removePatch = (patchId) => updateBoard(next => {
    next.patches = next.patches.filter(patch => patch.id !== patchId);
    next.chains.forEach(item => {
      item.rowIds = item.rowIds.filter(rowId => rowId !== patchId);
    });
  });

  const setPatchMode = (patchId, mode) => updateBoard(next => {
    const patch = next.patches.find(item => item.id === patchId);
    if (patch) patch.output = { ...(patch.output || {}), mode };
  });

  // Serialize the current patch board into the firmware's runtime contract.
  // Direct push is only for local HTTP/file Studio sessions; hosted HTTPS
  // flows use the copy-paste fallback shown by the error state.
  const pushToCard = async () => {
    const cleanHost = pushHost.trim().toLowerCase() || 'lightweaver.local';
    setCardHostname(cleanHost);
    setPushHost(getCardHostname());
    setPushKind('pending');
    setPushStatus(`Pushing to ${cleanHost}...`);
    setPushFallbackJson('');
    const zones = patchBoardToZones(board, strips);
    const outputs = (standaloneController?.outputs || []).map((o, i) => ({
      id: o.id || `out${i + 1}`,
      name: o.name || `Output ${i + 1}`,
      pin: o.pin,
      pixels: o.pixels,
    }));
    const totalPixels = strips.reduce((sum, s) => sum + (s.pixelCount ?? s.pixels?.length ?? 0), 0);
    const pkg = makeCardRuntimePackage({
      projectId,
      projectName,
      mode: 'website-flash',
      led: {
        pixels: totalPixels || undefined,
        colorOrder: standaloneController?.led?.colorOrder,
        brightnessLimit: standaloneController?.led?.brightnessLimit,
        outputs: outputs.length ? outputs : undefined,
      },
      controls: standaloneController?.controls,
      zones,
      syncZones: zones.length <= 1,
    });
    try {
      await pushConfigToCard(pkg, { host: getCardHostname(), allowLayoutChange: true });
      setPushKind('ok');
      setPushStatus(`Pushed ${zones.length} zone${zones.length === 1 ? '' : 's'} to ${cleanHost}`);
      setTimeout(() => { setPushStatus(''); setPushKind(''); }, 4000);
    } catch (err) {
      setPushKind('err');
      if (err instanceof CardPushError && err.reason === 'mixed-content') {
        setPushStatus('Browser blocked the request. Use the JSON below: connect to the card and paste at its onboard page.');
        setPushFallbackJson(JSON.stringify(pkg.config, null, 2));
      } else if (err instanceof CardPushError) {
        setPushStatus(err.message);
      } else {
        setPushStatus(`Push failed: ${err.message || err}`);
      }
    }
  };

  const resetActivePath = () => {
    if (!activeStrip || board.physicalLocked) return;
    updateBoard(next => sliceStripIntoPatchesPreservingRoute(next, activeStrip, []));
    setSelectedPatchId(null);
    if (selectedWireCut?.stripId === activeStrip.id) onClearSelectedCut?.();
  };

  const addOffBlock = () => updateBoard(next => {
    const patch = addOffPatch(next, offCount);
    setSelectedPatchId(patch.id);
  });

  const selectedRow = selectedPatch ? rowsByPatchId.get(selectedPatch.id) : null;
  const selectedIsOff = selectedPatch?.source?.type === 'off';

  return (
    <div className={`lw-wire-path ${embedded ? 'is-embedded' : ''}`}>
      <div className="lw-wire-head">
        <div>
          <h1>Wire Path</h1>
          <p>Physical route setup for the selected artwork layers.</p>
        </div>
        <div className="lw-wire-head-actions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-3, #9a8d75)' }}>
            Saved into the Chip package
          </span>
          <button
            className={`btn ${board.physicalLocked ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => updateBoard(next => { next.physicalLocked = !next.physicalLocked; })}
          >
            {board.physicalLocked ? 'Locked' : 'Unlocked'}
          </button>
        </div>
      </div>

      {pushStatus && (
        <div style={{
          padding: '10px 14px',
          margin: '4px 0 12px',
          borderRadius: 8,
          fontSize: 13,
          background: pushKind === 'ok' ? 'rgba(127,176,105,0.1)' : pushKind === 'err' ? 'rgba(224,120,86,0.1)' : 'rgba(154,141,117,0.1)',
          border: `1px solid ${pushKind === 'ok' ? 'rgba(127,176,105,0.5)' : pushKind === 'err' ? 'rgba(224,120,86,0.5)' : 'rgba(154,141,117,0.3)'}`,
          color: pushKind === 'ok' ? '#7fb069' : pushKind === 'err' ? '#e07856' : '#9a8d75',
        }}>
          {pushStatus}
          {pushFallbackJson && (
            <textarea
              readOnly
              value={pushFallbackJson}
              onClick={e => e.target.select()}
              style={{
                width: '100%',
                minHeight: 140,
                marginTop: 10,
                fontFamily: 'ui-monospace, SF Mono, monospace',
                fontSize: 11,
                padding: 10,
                borderRadius: 6,
                border: '1px solid var(--border, #333)',
                background: 'var(--bg-1, #0a0a0a)',
                color: 'var(--text-2, #c89b5c)',
                boxSizing: 'border-box',
              }}
            />
          )}
        </div>
      )}

      {selectedWireCut && (
        <section className="lw-wire-selected-detail">
          <div className="lw-wire-section-title">
            <span>Selected cut</span>
            <strong>LED {selectedWireCut.cutLed}</strong>
          </div>
          <div className="lw-wire-tool-row">
            <button
              className="btn btn-ghost"
              aria-label="Move cut earlier"
              disabled={board.physicalLocked}
              onClick={() => onNudgeSelectedCut?.(-1)}
            >
              -
            </button>
            <button
              className="btn btn-ghost"
              aria-label="Move cut later"
              disabled={board.physicalLocked}
              onClick={() => onNudgeSelectedCut?.(1)}
            >
              +
            </button>
            <button
              className="btn btn-ghost lw-btn-danger"
              aria-label="Delete cut"
              disabled={board.physicalLocked}
              onClick={() => onDeleteSelectedCut?.()}
            >
              Delete
            </button>
          </div>
        </section>
      )}

      <section className="lw-wire-source">
        <div className="lw-wire-section-title">
          <span>Source Paths</span>
          <strong>{strips.length} paths</strong>
        </div>
        <div className="lw-wire-source-list">
          {strips.map(strip => (
            <button
              key={strip.id}
              className={`lw-wire-source-row ${strip.id === activeStrip?.id ? 'active' : ''}`}
              onClick={() => { setActiveStripId(strip.id); setSelectedPatchId(null); }}
              title={strip.name}
            >
              <span className="lw-wire-source-dot" style={{ background: strip.color }}/>
              <span>{friendlyName(strip.name)}</span>
              <strong>{strip.pixelCount}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="lw-wire-cut-summary">
        <div className="lw-wire-section-title">
          <span>Canvas cuts</span>
          <strong>{pluralize(activeCuts.length, 'cut')}</strong>
        </div>
        <div className="lw-wire-cut-summary-row">
          <span className="lw-wire-cut-summary-name">{friendlyName(activeStrip?.name)}</span>
          <button className="btn btn-ghost" disabled={!activeStrip || board.physicalLocked || activeCuts.length === 0} onClick={resetActivePath}>
            Clear cuts
          </button>
        </div>
      </section>

      <section className="lw-wire-order">
        <div className="lw-wire-section-title">
          <span>Wire order</span>
          <strong>{orderedPatches.length} runs</strong>
        </div>
        <div className="lw-wire-chip-row">
          {orderedPatches.map((patch, index) => {
            const isOff = patch.source?.type === 'off';
            const active = patch.id === selectedPatch?.id;
            return (
              <button
                key={patch.id}
                className={`lw-wire-segment-chip ${active ? 'active' : ''} ${isOff ? 'lw-wire-off-chip' : ''}`}
                onClick={() => setSelectedPatchId(patch.id)}
                title={isOff ? `${patchLength(patch)} off LEDs` : `${patchLength(patch)} LEDs`}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{isOff ? 'Off' : friendlyName(patch.name)}</strong>
                <em>{isOff ? `x${patchLength(patch)}` : patchDirection(patch)}</em>
              </button>
            );
          })}
        </div>
      </section>

      <section className="lw-wire-tools">
        <div className="lw-wire-tool-row">
          <button
            className="btn btn-ghost"
            disabled={!selectedPatch || selectedIsOff || board.physicalLocked}
            onClick={() => reversePatch(selectedPatch)}
          >
            Reverse
          </button>
          <button
            className="btn btn-ghost"
            disabled={!selectedPatch || board.physicalLocked}
            onClick={() => updateBoard(next => movePatch(next, selectedPatch.id, 'up'))}
          >
            Earlier
          </button>
          <button
            className="btn btn-ghost"
            disabled={!selectedPatch || board.physicalLocked}
            onClick={() => updateBoard(next => movePatch(next, selectedPatch.id, 'down'))}
          >
            Later
          </button>
          <button
            className="btn btn-ghost lw-btn-danger"
            disabled={!selectedPatch || board.physicalLocked}
            onClick={() => removePatch(selectedPatch.id)}
          >
            Delete
          </button>
        </div>
        <div className="lw-wire-tool-row">
          <input
            className="lw-wire-off-input"
            type="number"
            min="1"
            value={offCount}
            onChange={event => setOffCount(Math.max(1, Math.trunc(Number(event.target.value) || 1)))}
            aria-label="Off LED count"
          />
          <button className="btn" disabled={board.physicalLocked} onClick={addOffBlock}>
            Insert off LEDs
          </button>
          <button
            className="btn btn-ghost"
            disabled={!selectedPatch}
            onClick={() => setAdvancedOpen(open => !open)}
          >
            Advanced
          </button>
        </div>
      </section>

      {advancedOpen && selectedPatch && (
        <section className="lw-wire-advanced">
          <div className="lw-wire-section-title">
            <span>Advanced</span>
            <strong>{selectedRow?.count ?? patchLength(selectedPatch)} exported</strong>
          </div>
          {selectedIsOff ? (
            <label>
              Off LEDs
              <input
                type="number"
                min="1"
                disabled={board.physicalLocked}
                value={selectedPatch.source.ledCount}
                onChange={event => updateBoard(next => {
                  const patch = next.patches.find(item => item.id === selectedPatch.id);
                  if (!patch) return;
                  patch.source.ledCount = Math.max(1, Math.trunc(Number(event.target.value) || 1));
                  patch.name = `Off ${patch.source.ledCount} LEDs`;
                })}
              />
            </label>
          ) : (
            <>
              <label>
                Start LED
                <input
                  type="number"
                  disabled={board.physicalLocked}
                  value={selectedPatch.source.startLed}
                  onChange={event => updateBoard(next => updatePatchRange(next, selectedPatch.id, event.target.value, selectedPatch.source.endLed))}
                />
              </label>
              <label>
                End LED
                <input
                  type="number"
                  disabled={board.physicalLocked}
                  value={selectedPatch.source.endLed}
                  onChange={event => updateBoard(next => updatePatchRange(next, selectedPatch.id, selectedPatch.source.startLed, event.target.value))}
                />
              </label>
              <label>
                Output
                <select
                  value={selectedPatch.output?.mode || 'normal'}
                  onChange={event => setPatchMode(selectedPatch.id, event.target.value)}
                >
                  <option value="normal">On</option>
                  <option value="off">Off</option>
                </select>
              </label>
            </>
          )}
        </section>
      )}
    </div>
  );
}
