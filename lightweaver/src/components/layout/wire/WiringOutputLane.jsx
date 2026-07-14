import { WiringRunRow } from './WiringRunRow.jsx';

export function WiringOutputLane({
  output, runs, compiledRuns, stripsById, selectedRunId, connectionState,
  advanced, locked, onSelectRun, onPort, onCordPointerDown, onCordPointerUp, onCordTargetEnter, onRowPointerDown, onMove, onRemove, onReverse,
  draggingRunId, dropTargetRunId, dropTarget,
  dropPlacement, onAdjustCount,
  supportedPins = [], unavailablePins = [], onPinChange,
  onOutputPointerDown, onMoveOutput, onRemoveOutput, outputDragging, outputDropPlacement,
}) {
  const compiledById = new Map(compiledRuns.map(run => [run.id, run]));
  return (
    <section className={`lw-wiring-output${dropTarget && !dropTargetRunId ? ' is-drop-target' : ''}${outputDragging ? ' is-output-dragging' : ''}${outputDropPlacement ? ` is-output-drop-${outputDropPlacement}` : ''}`} data-testid="wiring-output-lane" data-output-id={output.id}>
      <header>
        <button className="lw-output-drag" aria-label={`Drag ${output.name}`} aria-pressed={outputDragging} title="Drag output lane. Alt+arrow keys also reorder it." disabled={locked} onPointerDown={event => { event.stopPropagation(); onOutputPointerDown(output.id, event); }} onClick={event => event.stopPropagation()} onKeyDown={event => {
          if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); onMoveOutput(-1); }
          if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); onMoveOutput(1); }
        }}>⋮⋮</button>
        <button
          className="lw-wire-port lw-output-port"
          aria-label={`${output.name || output.id} OUT port`}
          aria-pressed={connectionState.sourceId === `output:${output.id}`}
          disabled={locked}
          onPointerDown={event => onCordPointerDown(`output:${output.id}`, event)}
          onPointerUp={event => onCordPointerUp(`output:${output.id}`, event)}
          onClick={() => onPort(`output:${output.id}`, 'out')}
        >OUT</button>
        <h3>{output.name || output.id}</h3>
        <span>{runs.reduce((sum, run) => sum + (compiledById.get(run.id)?.count || 0), 0)} px</span>
        <select className="lw-output-gpio" aria-label={`${output.name} GPIO`} value={output.pin} disabled={locked} onChange={event => onPinChange(Number(event.target.value))}>
          {supportedPins.map(pin => <option key={pin} value={pin} disabled={pin !== output.pin && unavailablePins.includes(pin)}>GPIO {pin}</option>)}
        </select>
        <button className="lw-wire-remove" aria-label={`Remove ${output.name}`} title={runs.length ? `Remove all runs before removing ${output.name}` : `Remove ${output.name}`} disabled={locked || runs.length > 0} onClick={() => onRemoveOutput()}>×</button>
      </header>
      <div role="listbox" aria-label={`${output.name || output.id} runs`}>
        {runs.length === 0 && <p className="la-wire-chain-empty">Connect a run to this output.</p>}
        {runs.map(run => (
          <WiringRunRow
            key={run.id}
            run={run}
            compiledRun={compiledById.get(run.id)}
            stripsById={stripsById}
            selected={selectedRunId === run.id}
            connectionState={connectionState}
            locked={locked}
            onSelect={() => onSelectRun(run)}
            onPort={port => onPort(run.id, port)}
            onCordPointerDown={onCordPointerDown}
            onCordPointerUp={onCordPointerUp}
            onCordTargetEnter={onCordTargetEnter}
            onRowPointerDown={onRowPointerDown}
            dragging={draggingRunId === run.id}
            dropTarget={dropTargetRunId === run.id && draggingRunId !== run.id}
            dropPlacement={dropPlacement}
            onMove={delta => onMove(output.id, run.id, delta)}
            onRemove={() => onRemove(output.id, run.id)}
            onReverse={() => onReverse(run.id)}
            onAdjustCount={delta => onAdjustCount(run.id, delta)}
          />
        ))}
      </div>
    </section>
  );
}
