import { useState } from 'react';
import { useProject } from '../../../state/ProjectContext.jsx';
import {
  addOffPatch,
  cutsForStrip,
  expandPatchBoard,
  mainChain,
  movePatch,
  normalizePatchBoard,
  sliceStripIntoPatchesPreservingRoute,
  updatePatchRange,
} from '../../../lib/patchBoard.js';
import {
  toWLEDLedmap,
  pixelsFromPatchBoard,
  download,
} from '../../../lib/export.js';
import { DragHandleIcon, InlineRename } from '../shared/InspectorPrimitives.jsx';
import { CardPushControl } from '../shared/CardPushControl.jsx';

// ── Wire-mode side panel (Phase 2 step 9) ────────────────────────────────────
// Absorbs the entire embedded PatchBoardScreen (which no longer exists) plus the
// strip list rendered AS the wiring chain, and ends with the screen's finish
// line: Send to card + Export ledmap.json. The wire content is a verbatim lift
// of PatchBoardScreen's embedded body — same handlers, same `.lw-wire-*` DOM,
// always expanded (no `<details>` disclosure). The chain rows on top replace the
// old source-path selector: clicking a row selects the strip (which the cut
// summary + selected-split editor + advanced range editor target).

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

function startedFromDragHandle(e) {
  return !!e.target?.closest?.('[data-drag-handle="true"]');
}

export function WireModePanel({ state, connected }) {
  const {
    strips, patchBoard, hidden,
    orderedStrips, reorderStripRows, renameStrip,
    selectStrip, selStripId, selectedStripIds,
    readDraggedStripIds, stripGroupDragOver, setStripGroupDragOver,
    // wire-cut selection (from useLayoutWire)
    selectedWireCut, setSelectedWireCut,
    nudgeSelectedWireCut, deleteSelectedWireCut,
  } = state;

  // `updatePatchBoard` (the history-aware patch-board mutator) + the project
  // identity/controller fields that CardPushControl needs are not surfaced
  // through useLayoutState, so read them from the project context directly.
  const { updatePatchBoard, projectId, projectName, standaloneController } = useProject();

  const [selectedPatchId, setSelectedPatchId] = useState(null);
  const [offCount, setOffCount] = useState(1);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const board = normalizePatchBoard(patchBoard, strips);
  const expanded = expandPatchBoard(board, strips);
  const chain = mainChain(board);

  // The active strip = the current single strip selection (chain-row click /
  // canvas chop both drive it), falling back to the first strip.
  const activeStrip = strips.find(s => s.id === selStripId) || strips[0] || null;

  const patchesById = new Map(board.patches.map(patch => [patch.id, patch]));
  const rowsByPatchId = new Map(expanded.rows.map(row => [row.patchId, row]));
  const orderedPatches = chain.rowIds.map(id => patchesById.get(id)).filter(Boolean);
  const activeStripPatches = orderedPatches.filter(
    patch => patch.source?.type === 'strip' && patch.source.stripId === activeStrip?.id,
  );
  const selectedPatch = patchesById.get(selectedPatchId) || activeStripPatches[0] || orderedPatches[0] || null;
  const activeCuts = activeStrip ? cutsForStrip(board, activeStrip.id) : [];

  // Patch-board edits route through the context's history-aware mutation so
  // they join the shared undo stack (interleaved with strip edits).
  const updateBoard = updatePatchBoard;

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

  const resetActivePath = () => {
    if (!activeStrip || board.physicalLocked) return;
    updateBoard(next => sliceStripIntoPatchesPreservingRoute(next, activeStrip, []));
    setSelectedPatchId(null);
    if (selectedWireCut?.stripId === activeStrip.id) setSelectedWireCut(null);
  };

  const addOffBlock = () => {
    let newPatchId = null;
    updateBoard(next => { newPatchId = addOffPatch(next, offCount).id; });
    if (newPatchId) setSelectedPatchId(newPatchId);
  };

  const exportLedmap = () => {
    const pixels = pixelsFromPatchBoard(patchBoard, strips);
    download(toWLEDLedmap(pixels), 'ledmap.json', 'application/json');
  };

  const selectedRow = selectedPatch ? rowsByPatchId.get(selectedPatch.id) : null;
  const selectedIsOff = selectedPatch?.source?.type === 'off';

  // Chain-row drag reorder (reuses the Draw-mode strip-list drag semantics, but
  // here a drop IS a chain mutation via reorderStripRows).
  const onRowDragStart = (e, id) => {
    if (!startedFromDragHandle(e)) { e.preventDefault(); return; }
    const ids = selectedStripIds.includes(id) ? selectedStripIds : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-lightweaver-strip', JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', ids.join(','));
  };

  return (
    <div className="lw-wire-path is-embedded la-wire-panel" data-testid="layout-wire-panel">

      {/* ── Chain: the strip list IS the wiring order ─────────────────────── */}
      <section className="lw-wire-chain">
        <div className="lw-wire-section-title">
          <span>Wiring chain</span>
          <strong>{pluralize(orderedStrips.length, 'strip')}</strong>
        </div>
        {orderedStrips.length === 0 ? (
          <p className="la-wire-chain-empty">
            Add strips in Draw mode — their order here is the order LEDs light along the wire.
          </p>
        ) : (
          <div className="la-wire-chain-list">
            {orderedStrips.map((s, i) => {
              const cuts = cutsForStrip(board, s.id);
              const isActive = s.id === selStripId;
              const isBatch = selectedStripIds.includes(s.id);
              return (
                <div
                  key={s.id}
                  data-strip-id={s.id}
                  data-testid="layout-wire-chain-row"
                  className={`la-wire-chain-row${isActive ? ' active' : ''}`}
                  draggable
                  onDragStart={e => onRowDragStart(e, s.id)}
                  onDragOver={e => {
                    if (!Array.from(e.dataTransfer.types).includes('application/x-lightweaver-strip')) return;
                    e.preventDefault();
                    setStripGroupDragOver(`strip:${s.id}`);
                  }}
                  onDragLeave={() => setStripGroupDragOver(null)}
                  onDrop={e => {
                    const draggedStripIds = readDraggedStripIds(e);
                    if (!draggedStripIds.length) return;
                    e.preventDefault();
                    e.stopPropagation();
                    reorderStripRows(draggedStripIds, s.id);
                    setStripGroupDragOver(null);
                  }}
                  onDragEnd={() => setStripGroupDragOver(null)}
                  style={{ opacity: hidden[s.id] ? 0.4 : 1,
                           outline: stripGroupDragOver === `strip:${s.id}` ? '1px solid var(--accent)' : undefined,
                           outlineOffset: -1 }}
                  onClick={() => { selectStrip(s.id); setSelectedPatchId(null); }}>
                  <span data-drag-handle="true" className="la-wire-chain-grip" title="Drag to reorder the wire chain"
                        style={{ color: isBatch ? 'var(--accent)' : undefined }}>
                    <span className="la-wire-chain-n">{String(i + 1).padStart(2, '0')}</span>
                    <DragHandleIcon/>
                  </span>
                  <span className="layer-swatch" style={{ borderRadius: '50%', background: s.color,
                                 boxShadow: isActive ? `0 0 8px ${s.color}` : undefined }}/>
                  <InlineRename value={s.name} onCommit={n => renameStrip(s.id, n)}
                                className="nm" style={{ flex: 1, minWidth: 0 }}/>
                  {s.reversed && <span className="la-strip-rev">REV</span>}
                  {cuts.length > 0 && (
                    <span className="la-wire-chain-splits" title={`${cuts.length} split${cuts.length === 1 ? '' : 's'}`}>
                      {pluralize(cuts.length + 1, 'run')}
                    </span>
                  )}
                  <span className="layer-len">{s.pixelCount} px</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Selected split (mini-editor) ──────────────────────────────────── */}
      {selectedWireCut && (
        <section className="lw-wire-selected-detail">
          <div className="lw-wire-section-title">
            <span>Selected split</span>
            <strong>LED {selectedWireCut.cutLed}</strong>
          </div>
          <div className="lw-wire-tool-row">
            <button
              className="btn btn-ghost"
              aria-label="Move cut earlier"
              disabled={board.physicalLocked}
              onClick={() => nudgeSelectedWireCut(-1)}
            >
              -
            </button>
            <button
              className="btn btn-ghost"
              aria-label="Move cut later"
              disabled={board.physicalLocked}
              onClick={() => nudgeSelectedWireCut(1)}
            >
              +
            </button>
            <button
              className="btn btn-ghost lw-btn-danger"
              aria-label="Delete cut"
              disabled={board.physicalLocked}
              onClick={() => deleteSelectedWireCut()}
            >
              Delete
            </button>
          </div>
        </section>
      )}

      {/* ── Cut summary + merge-back ──────────────────────────────────────── */}
      <section className="lw-wire-cut-summary">
        <div className="lw-wire-section-title">
          <span>Splits</span>
          <strong>{pluralize(activeCuts.length, 'cut')}</strong>
        </div>
        <div className="lw-wire-cut-summary-row">
          <span className="lw-wire-cut-summary-name">{friendlyName(activeStrip?.name)}</span>
          <button className="btn btn-ghost" disabled={!activeStrip || board.physicalLocked || activeCuts.length === 0} onClick={resetActivePath}>
            Merge back into one strip
          </button>
        </div>
      </section>

      {/* ── Wiring-order chips + segment tools (only once split into runs) ─── */}
      {orderedPatches.length > strips.length && (<>
      <section className="lw-wire-order">
        <div className="lw-wire-section-title">
          <span>Wiring order</span>
          <strong>{orderedPatches.length} segments</strong>
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
                title={isOff ? `${patchLength(patch)} unlit LEDs` : `${patchLength(patch)} LEDs`}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>
                  {isOff ? 'Gap' : friendlyName(patch.name)}
                  {!isOff && <small> part {index + 1}</small>}
                </strong>
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
            Add a gap
          </button>
          <button
            className="btn btn-ghost"
            disabled={!selectedPatch}
            onClick={() => setAdvancedOpen(open => !open)}
          >
            Edit LED range
          </button>
        </div>
      </section>
      </>)}

      {/* ── Advanced LED-range editor ─────────────────────────────────────── */}
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

      {/* ── Finish line: Send to card + Export ledmap.json ────────────────── */}
      <section className="lw-wire-finish">
        <CardPushControl
          connected={connected}
          board={board}
          strips={strips}
          projectId={projectId}
          projectName={projectName}
          standaloneController={standaloneController}
        >
          <button
            className="btn la-export-ledmap"
            data-testid="layout-export-ledmap"
            onClick={exportLedmap}
            title="Download a WLED ledmap.json for this layout"
          >
            Export ledmap.json
          </button>
        </CardPushControl>
      </section>
    </div>
  );
}
