import { useState } from 'react';

function runLabel(run, stripsById) {
  if (run.type === 'inactive') return 'Reserved · unlit';
  if (run.type === 'cable') return 'Cable jump';
  const strip = stripsById.get(run.source?.stripId);
  return strip?.name || run.source?.stripId || run.id;
}

export function WiringRunRow({
  run, compiledRun, stripsById, selected, connectionState,
  onSelect, onPort, onCordPointerDown, onCordPointerUp, onCordTargetEnter, onRowPointerDown, onMove, onRemove, onReverse, locked,
  dragging, dropTarget, dropPlacement, onAdjustCount,
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const label = runLabel(run, stripsById);
  const sourceSelected = connectionState.sourceId === run.id;
  const count = compiledRun?.count ?? (run.type === 'inactive' ? run.count : 0);
  return (
    <div
      className={`lw-wiring-run${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ` is-drop-${dropPlacement || 'before'}` : ''}`}
      data-testid="wiring-run-row"
      data-run-id={run.id}
      role="option"
      aria-selected={selected}
      aria-roledescription="reorderable wiring run"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); }
        if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); onMove(-1); }
        if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); onMove(1); }
        if (event.key === 'Delete') { event.preventDefault(); if (!locked) setConfirmRemove(true); }
      }}
    >
      <button className="lw-wire-drag" aria-label={`Drag ${label}`} aria-pressed={dragging} title="Drag to reorder. Alt+arrow keys also move this run." disabled={locked} onPointerDown={event => { event.stopPropagation(); onRowPointerDown(run.id, event); }} onClick={event => event.stopPropagation()}>⋮⋮</button>
      <button className="lw-wire-port lw-run-in" data-wire-in={run.id} aria-label={`${label} IN port`} title="LED strip data input" onPointerEnter={() => onCordTargetEnter(run.id)} onClick={event => { event.stopPropagation(); onPort('in'); }}>IN</button>
      <span className="lw-wiring-run-name">{label}</span>
      <span className="lw-run-tools">
        {run.type === 'strip' ? (
          <span className="lw-inline-pixel-count" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
            <button aria-label={`Remove one LED from ${label}`} disabled={locked || count <= 1} onClick={() => onAdjustCount(-1)}>−</button>
            <strong data-testid="inline-run-count">{count}</strong>
            <button aria-label={`Add one LED to ${label}`} disabled={locked} onClick={() => onAdjustCount(1)}>+</button>
          </span>
        ) : <span className="lw-wiring-run-count">{run.type === 'cable' ? 'wire' : `${count} LEDs`}</span>}
        {run.type === 'strip' && <button className="lw-run-flip" aria-label="Flip" title={`Flip ${label} mapping direction`} disabled={locked || run.directionPolicy === 'fixed'} onClick={event => { event.stopPropagation(); onReverse(); }}>Flip</button>}
      </span>
      <button
        className="lw-wire-port lw-run-out"
        aria-label={`${label} OUT port`}
        aria-pressed={sourceSelected}
        disabled={locked}
        onPointerDown={event => { event.stopPropagation(); onCordPointerDown(run.id, event); }}
        onPointerUp={event => { event.stopPropagation(); onCordPointerUp(run.id, event); }}
        onClick={event => { event.stopPropagation(); onPort('out'); }}
        title="LED strip data output"
      >OUT</button>
      <button
        className={`lw-wire-remove lw-run-remove${confirmRemove ? ' is-confirming' : ''}`}
        aria-label={confirmRemove ? `Confirm remove ${label}` : `Remove ${label}`}
        title={`Remove ${label} from this LED output`}
        disabled={locked}
        onBlur={() => setConfirmRemove(false)}
        onClick={event => { event.stopPropagation(); if (confirmRemove) onRemove(); else setConfirmRemove(true); }}
      >{confirmRemove ? 'Remove?' : 'Remove'}</button>
    </div>
  );
}
