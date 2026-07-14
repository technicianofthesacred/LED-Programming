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
        if (event.key === 'Delete') { event.preventDefault(); onRemove(); }
      }}
    >
      <button className="lw-wire-drag" aria-label={`Drag ${label}`} aria-pressed={dragging} title="Drag to reorder. Alt+arrow keys also move this run." disabled={locked} onPointerDown={event => { event.stopPropagation(); onRowPointerDown(run.id, event); }} onClick={event => event.stopPropagation()}>⋮⋮</button>
      <button className="lw-wire-port" data-wire-in={run.id} aria-label={`${label} IN port`} onPointerEnter={() => onCordTargetEnter(run.id)} onClick={event => { event.stopPropagation(); onPort('in'); }}>IN</button>
      <span className="lw-wiring-run-name">{label}</span>
      {run.type === 'strip' ? (
        <span className="lw-inline-pixel-count" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
          <button aria-label={`Remove one pixel from ${label}`} disabled={locked || count <= 1} onClick={() => onAdjustCount(-1)}>−</button>
          <strong data-testid="inline-run-count">{count}</strong>
          <button aria-label={`Add one pixel to ${label}`} disabled={locked} onClick={() => onAdjustCount(1)}>+</button>
        </span>
      ) : <span className="lw-wiring-run-count">{run.type === 'cable' ? 'wire' : `${count} px`}</span>}
      {run.type === 'strip' && <button aria-label="Flip" title={`Flip ${label} mapping direction`} disabled={locked || run.directionPolicy === 'fixed'} onClick={event => { event.stopPropagation(); onReverse(); }}>Flip</button>}
      <button
        className="lw-wire-port"
        aria-label={`${label} OUT port`}
        aria-pressed={sourceSelected}
        disabled={locked}
        onPointerDown={event => { event.stopPropagation(); onCordPointerDown(run.id, event); }}
        onPointerUp={event => { event.stopPropagation(); onCordPointerUp(run.id, event); }}
        onClick={event => { event.stopPropagation(); onPort('out'); }}
      >OUT</button>
      <button className="lw-wire-remove" aria-label={`Remove ${label}`} title={`Remove ${label}`} disabled={locked} onClick={event => { event.stopPropagation(); onRemove(); }}>×</button>
    </div>
  );
}
