import { WiringRunRow } from './WiringRunRow.jsx';

export function WiringOutputLane({
  output, runs, compiledRuns, stripsById, selectedRunId, connectionState,
  advanced, locked, onSelectRun, onPort, onCordPointerDown, onMove, onRemove, onReverse,
}) {
  const compiledById = new Map(compiledRuns.map(run => [run.id, run]));
  return (
    <section className="lw-wiring-output" data-testid="wiring-output-lane" data-output-id={output.id}>
      <header>
        <button
          className="lw-wire-port lw-output-port"
          aria-label={`${output.name || output.id} OUT port`}
          aria-pressed={connectionState.sourceId === `output:${output.id}`}
          disabled={locked}
          onClick={() => onPort(`output:${output.id}`, 'out')}
        >OUT</button>
        <h3>{output.name || output.id}</h3>
        <span>{runs.reduce((sum, run) => sum + (compiledById.get(run.id)?.count || 0), 0)} px</span>
        {advanced && <span>GPIO {output.pin}</span>}
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
            onMove={delta => onMove(output.id, run.id, delta)}
            onRemove={() => onRemove(output.id, run.id)}
            onReverse={() => onReverse(run.id)}
          />
        ))}
      </div>
    </section>
  );
}
