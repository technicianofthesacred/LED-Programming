import { useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  addOffPatch,
  expandPatchBoard,
  mainChain,
  movePatch,
  normalizePatchBoard,
  updatePatchRange,
} from '../lib/patchBoard.js';

function patchLength(patch) {
  if (patch.source?.type === 'off') return Math.max(0, Math.trunc(patch.source.ledCount || 0));
  const start = Number(patch.source?.startLed);
  const end = Number(patch.source?.endLed);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.abs(Math.trunc(end) - Math.trunc(start)) + 1;
}

function sourceLabel(patch, stripsById) {
  if (patch.source?.type === 'off') return 'Off block';
  const strip = stripsById.get(patch.source?.stripId);
  return strip?.name || strip?.id || 'Missing strip';
}

export function PatchBoardScreen({ embedded = false }) {
  const { strips, patchBoard, setPatchBoard } = useProject();
  const [offCount, setOffCount] = useState(1);

  const board = useMemo(() => normalizePatchBoard(patchBoard, strips), [patchBoard, strips]);
  const expanded = useMemo(() => expandPatchBoard(board, strips), [board, strips]);
  const chain = mainChain(board);
  const patchesById = useMemo(() => new Map(board.patches.map(patch => [patch.id, patch])), [board.patches]);
  const stripsById = useMemo(() => new Map(strips.map(strip => [strip.id, strip])), [strips]);
  const rowsByPatchId = useMemo(() => new Map(expanded.rows.map(row => [row.patchId, row])), [expanded.rows]);

  const updateBoard = (mutate) => {
    setPatchBoard(prev => {
      const next = normalizePatchBoard(prev, strips);
      mutate(next);
      return normalizePatchBoard(next, strips);
    });
  };

  const setPatchSource = (patchId, updater) => updateBoard(next => {
    const patch = next.patches.find(item => item.id === patchId);
    if (!patch) return;
    updater(patch);
  });

  const removePatch = (patchId) => updateBoard(next => {
    next.patches = next.patches.filter(patch => patch.id !== patchId);
    next.chains.forEach(item => {
      item.rowIds = item.rowIds.filter(rowId => rowId !== patchId);
    });
  });

  const resetBoard = () => setPatchBoard(normalizePatchBoard(null, strips));

  return (
    <div className={`lw-patch-screen ${embedded ? 'is-embedded' : ''}`}>
      <section className="lw-patch-board">
        <div className="lw-patch-head">
          <div>
            <h1>Patch Board</h1>
            <p>Physical LED order for export. Reorder sections, reverse ranges, and reserve hidden/off LEDs.</p>
          </div>
          <div className="lw-patch-actions">
            <button
              className={`btn ${board.physicalLocked ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => updateBoard(next => { next.physicalLocked = !next.physicalLocked; })}
            >
              {board.physicalLocked ? 'Locked' : 'Setup unlocked'}
            </button>
            <button className="btn btn-ghost" disabled={board.physicalLocked} onClick={resetBoard}>Reset</button>
          </div>
        </div>

        <div className="lw-patch-metrics">
          <div><span>Physical LEDs</span><strong>{expanded.pixels.length}</strong></div>
          <div><span>Patches</span><strong>{chain.rowIds.length}</strong></div>
          <div><span>Source strips</span><strong>{strips.length}</strong></div>
        </div>

        <div className="lw-patch-add">
          <label>
            Off LEDs
            <input
              type="number"
              min="1"
              value={offCount}
              onChange={event => setOffCount(Math.max(1, Math.trunc(Number(event.target.value) || 1)))}
            />
          </label>
          <button className="btn" disabled={board.physicalLocked} onClick={() => updateBoard(next => addOffPatch(next, offCount))}>
            Add off block
          </button>
        </div>

        <div className="lw-patch-rows">
          {chain.rowIds.map((patchId, rowIndex) => {
            const patch = patchesById.get(patchId);
            if (!patch) return null;
            const row = rowsByPatchId.get(patch.id) || { startIndex: 0, count: 0 };
            const endIndex = row.count ? row.startIndex + row.count - 1 : row.startIndex;
            const isOff = patch.source?.type === 'off';
            return (
              <div key={patch.id} className={`lw-patch-row ${isOff ? 'is-off' : ''}`}>
                <div className="lw-patch-order">
                  <span>{String(rowIndex + 1).padStart(2, '0')}</span>
                  <button disabled={board.physicalLocked} title="Move earlier" onClick={() => updateBoard(next => movePatch(next, patch.id, 'up'))}>↑</button>
                  <button disabled={board.physicalLocked} title="Move later" onClick={() => updateBoard(next => movePatch(next, patch.id, 'down'))}>↓</button>
                </div>
                <div className="lw-patch-main">
                  <div className="lw-patch-title">
                    <strong>{patch.name}</strong>
                    <span>{sourceLabel(patch, stripsById)}</span>
                  </div>
                  <div className="lw-patch-range">
                    {isOff ? (
                      <label>
                        Reserve
                        <input
                          type="number"
                          min="1"
                          disabled={board.physicalLocked}
                          value={patch.source.ledCount}
                          onChange={event => setPatchSource(patch.id, item => {
                            item.source.ledCount = Math.max(1, Math.trunc(Number(event.target.value) || 1));
                            item.name = `Off ${item.source.ledCount} LEDs`;
                          })}
                        />
                      </label>
                    ) : (
                      <>
                        <label>
                          Start
                          <input
                          type="number"
                          disabled={board.physicalLocked}
                          value={patch.source.startLed}
                          onChange={event => updateBoard(next => updatePatchRange(next, patch.id, event.target.value, patch.source.endLed))}
                          />
                        </label>
                        <label>
                          End
                          <input
                          type="number"
                          disabled={board.physicalLocked}
                          value={patch.source.endLed}
                          onChange={event => updateBoard(next => updatePatchRange(next, patch.id, patch.source.startLed, event.target.value))}
                        />
                      </label>
                        <button className="btn btn-ghost" disabled={board.physicalLocked} onClick={() => updateBoard(next => updatePatchRange(next, patch.id, patch.source.endLed, patch.source.startLed))}>
                          Reverse
                        </button>
                      </>
                    )}
                    <label>
                      Output
                      <select
                        value={patch.output?.mode || 'normal'}
                        onChange={event => setPatchSource(patch.id, item => {
                          item.output = { ...(item.output || {}), mode: event.target.value };
                        })}
                      >
                        <option value="normal">On</option>
                        <option value="off">Off</option>
                      </select>
                    </label>
                  </div>
                </div>
                <div className="lw-patch-address">
                  <span>Out {row.count ? `${row.startIndex}-${endIndex}` : '—'}</span>
                  <strong>{patchLength(patch)} LEDs</strong>
                  {isOff && <button className="btn btn-ghost" disabled={board.physicalLocked} onClick={() => removePatch(patch.id)}>Remove</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {!embedded && (
        <aside className="lw-patch-side">
          <div className="lw-patch-side-block">
            <h2>Export order</h2>
            <p>The first row becomes LED address 0. A reversed range like 10 → 2 plays backward without changing the artwork.</p>
          </div>
          <div className="lw-patch-side-block">
            <h2>Warnings</h2>
            {expanded.warnings.length ? (
              <ul>
                {expanded.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
              </ul>
            ) : (
              <p>No mapping warnings.</p>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
