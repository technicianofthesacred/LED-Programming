function runLabel(run, stripsById) {
  if (run.type === 'inactive') return 'Reserved · unlit';
  if (run.type === 'cable') return 'Cable jump';
  const strip = stripsById.get(run.source?.stripId);
  return strip?.name || run.source?.stripId || run.id;
}

export function WiringRunRow({
  run, compiledRun, stripsById, selected, connectionState,
  onSelect, onPort, onCordPointerDown, onCordPointerUp, onCordTargetEnter, onRowPointerDown, onMove, onRemove, onReverse, locked,
}) {
  const label = runLabel(run, stripsById);
  const sourceSelected = connectionState.sourceId === run.id;
  const count = compiledRun?.count ?? (run.type === 'inactive' ? run.count : 0);
  return (
    <div
      className={`lw-wiring-run${selected ? ' is-selected' : ''}`}
      data-testid="wiring-run-row"
      data-run-id={run.id}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); }
        if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); onMove(-1); }
        if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); onMove(1); }
        if (event.key === 'Delete') { event.preventDefault(); onRemove(); }
      }}
    >
      <button className="lw-wire-drag" aria-label={`Drag ${label}`} disabled={locked} onPointerDown={event => { event.stopPropagation(); onRowPointerDown(run.id, event); }}>⋮⋮</button>
      <button className="lw-wire-port" data-wire-in={run.id} aria-label={`${label} IN port`} onPointerEnter={() => onCordTargetEnter(run.id)} onClick={event => { event.stopPropagation(); onPort('in'); }}>IN</button>
      <span className="lw-wiring-run-index">{String((compiledRun?.start ?? 0) + 1).padStart(3, '0')}</span>
      <span className="lw-wiring-run-name">{label}</span>
      <span className="lw-wiring-run-count">{run.type === 'cable' ? '0 addr' : `${count} px`}</span>
      {run.type === 'strip' && <button disabled={locked || run.directionPolicy === 'fixed'} onClick={event => { event.stopPropagation(); onReverse(); }}>Reverse</button>}
      <button aria-label="Move earlier" disabled={locked} onClick={event => { event.stopPropagation(); onMove(-1); }}>↑</button>
      <button aria-label="Move later" disabled={locked} onClick={event => { event.stopPropagation(); onMove(1); }}>↓</button>
      <button aria-label={`Remove ${label}`} disabled={locked} onClick={event => { event.stopPropagation(); onRemove(); }}>×</button>
      <button
        className="lw-wire-port"
        aria-label={`${label} OUT port`}
        aria-pressed={sourceSelected}
        disabled={locked}
        onPointerDown={event => { event.stopPropagation(); onCordPointerDown(run.id, event); }}
        onPointerUp={event => { event.stopPropagation(); onCordPointerUp(run.id, event); }}
        onClick={event => { event.stopPropagation(); onPort('out'); }}
      >OUT</button>
    </div>
  );
}
