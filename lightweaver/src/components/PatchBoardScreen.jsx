import { useEffect, useMemo, useState } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import {
  addOffPatch,
  expandPatchBoard,
  mainChain,
  movePatch,
  normalizePatchBoard,
  sliceStripIntoPatches,
  updatePatchRange,
} from '../lib/patchBoard.js';

const PREVIEW_W = 320;
const PREVIEW_H = 108;
const PREVIEW_PAD = 14;

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

function patchDirection(patch) {
  if (patch.source?.type === 'off') return '';
  return Number(patch.source.startLed) <= Number(patch.source.endLed) ? '->' : '<-';
}

function pathBounds(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return points.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point.x),
    minY: Math.min(acc.minY, point.y),
    maxX: Math.max(acc.maxX, point.x),
    maxY: Math.max(acc.maxY, point.y),
  }), {
    minX: points[0].x,
    minY: points[0].y,
    maxX: points[0].x,
    maxY: points[0].y,
  });
}

function previewPoints(strip) {
  const pixels = strip?.pixels || [];
  if (!pixels.length) return [];
  const bounds = pathBounds(pixels);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(
    (PREVIEW_W - PREVIEW_PAD * 2) / width,
    (PREVIEW_H - PREVIEW_PAD * 2) / height,
  );
  const renderedW = width * scale;
  const renderedH = height * scale;
  const offsetX = (PREVIEW_W - renderedW) / 2;
  const offsetY = (PREVIEW_H - renderedH) / 2;
  return pixels.map((pixel, index) => ({
    index,
    x: offsetX + (pixel.x - bounds.minX) * scale,
    y: offsetY + (pixel.y - bounds.minY) * scale,
  }));
}

function patchSpan(patch) {
  if (patch.source?.type !== 'strip') return null;
  const start = Number(patch.source.startLed);
  const end = Number(patch.source.endLed);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { min: Math.min(start, end), max: Math.max(start, end) };
}

function sourceCutsForStrip(board, stripId) {
  const patchesById = new Map(board.patches.map(patch => [patch.id, patch]));
  const patches = mainChain(board).rowIds
    .map(id => patchesById.get(id))
    .filter(patch => patch?.source?.type === 'strip' && patch.source.stripId === stripId)
    .sort((a, b) => (patchSpan(a)?.min ?? 0) - (patchSpan(b)?.min ?? 0));
  return patches.slice(0, -1)
    .map(patch => patchSpan(patch)?.max)
    .filter(value => Number.isFinite(value));
}

function nearestPreviewIndex(points, x, y) {
  if (!points.length) return 0;
  let best = points[0];
  let bestDistance = Infinity;
  for (const point of points) {
    const dx = point.x - x;
    const dy = point.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best.index;
}

function segmentPoints(points, patch) {
  const span = patchSpan(patch);
  if (!span) return [];
  return points.filter(point => point.index >= span.min && point.index <= span.max);
}

function pointsAttribute(points) {
  return points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

export function PatchBoardScreen({ embedded = false }) {
  const { strips, patchBoard, setPatchBoard } = useProject();
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
  const points = useMemo(() => previewPoints(activeStrip), [activeStrip]);
  const sourceCuts = activeStrip ? sourceCutsForStrip(board, activeStrip.id) : [];

  const updateBoard = (mutate) => {
    setPatchBoard(prev => {
      const next = normalizePatchBoard(prev, strips);
      mutate(next);
      return normalizePatchBoard(next, strips);
    });
  };

  const cutActivePath = (cutLed) => {
    if (!activeStrip || board.physicalLocked) return;
    const cuts = [...new Set([...sourceCuts, cutLed])];
    updateBoard(next => sliceStripIntoPatches(next, activeStrip, cuts));
  };

  const handleMapClick = (event) => {
    if (!activeStrip || !points.length || board.physicalLocked) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * PREVIEW_W;
    const y = ((event.clientY - rect.top) / rect.height) * PREVIEW_H;
    const cut = nearestPreviewIndex(points, x, y);
    cutActivePath(cut);
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

  const resetActivePath = () => {
    if (!activeStrip || board.physicalLocked) return;
    updateBoard(next => sliceStripIntoPatches(next, activeStrip, []));
    setSelectedPatchId(null);
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
          <p>Pick a source path, click where the real wire changes, then arrange the resulting runs.</p>
        </div>
        <div className="lw-wire-head-actions">
          <button
            className={`btn ${board.physicalLocked ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => updateBoard(next => { next.physicalLocked = !next.physicalLocked; })}
          >
            {board.physicalLocked ? 'Locked' : 'Unlocked'}
          </button>
        </div>
      </div>

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

      <section className="lw-wire-map-panel">
        <div className="lw-wire-map-top">
          <div>
            <span className="lw-wire-kicker">Chop path</span>
            <strong>{friendlyName(activeStrip?.name)}</strong>
          </div>
          <button className="btn btn-ghost" disabled={!activeStrip || board.physicalLocked} onClick={resetActivePath}>
            Clear cuts
          </button>
        </div>
        <svg
          className="lw-wire-map"
          viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
          role="img"
          aria-label="Click the visible source path to add a cut"
          onClick={handleMapClick}
        >
          <rect x="0" y="0" width={PREVIEW_W} height={PREVIEW_H} rx="8" className="lw-wire-map-bg"/>
          {points.length > 1 && (
            <polyline points={pointsAttribute(points)} className="lw-wire-map-base"/>
          )}
          {activeStripPatches.map((patch, index) => {
            const segment = segmentPoints(points, patch);
            if (segment.length < 2) return null;
            const mid = segment[Math.floor(segment.length / 2)];
            const isSelected = patch.id === selectedPatch?.id;
            return (
              <g key={patch.id}>
                <polyline
                  points={pointsAttribute(segment)}
                  className={`lw-wire-map-segment ${isSelected ? 'active' : ''}`}
                  style={{ '--seg-color': activeStrip?.color || 'var(--accent)' }}
                />
                <circle cx={mid.x} cy={mid.y} r={isSelected ? 6 : 4} className="lw-wire-map-segment-dot"/>
                <text x={mid.x} y={mid.y - 10} className="lw-wire-map-label">{index + 1} {patchDirection(patch)}</text>
              </g>
            );
          })}
          {sourceCuts.map(cut => {
            const point = points[cut];
            if (!point) return null;
            return <line key={cut} x1={point.x} y1="12" x2={point.x} y2={PREVIEW_H - 12} className="lw-wire-cut"/>;
          })}
        </svg>
        <div className="lw-wire-hint">
          Click the path preview to add a cut. Counts stay in Advanced unless you need them.
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
