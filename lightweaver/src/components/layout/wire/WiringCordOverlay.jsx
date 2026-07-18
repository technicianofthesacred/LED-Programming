export function WiringCordOverlay({ compiled, selectedRunId }) {
  // Label each strip with the same number the Wire order list shows (per data
  // wire, restarting at 1). The output name only appears with multiple wires —
  // "out1 · 1" style ids meant nothing to first-time wirers.
  const multiWire = compiled.outputs.length > 1;
  const outputNames = new Map(compiled.outputs.map(output => [output.id, output.name || output.id]));
  const positions = new Map();
  const counters = new Map();
  for (const run of compiled.runs) {
    if (run.type !== 'strip' || run.count <= 0) continue;
    const next = (counters.get(run.outputId) || 0) + 1;
    counters.set(run.outputId, next);
    positions.set(run.id, next);
  }
  return (
    <g className="lw-compiled-cords" pointerEvents="none">
      {compiled.runs.filter(run => run.type === 'strip' && run.count > 0).map(run => {
        const pixels = compiled.pixels.filter(pixel => pixel.runId === run.id && !pixel.inactive);
        if (!pixels.length) return null;
        const first = pixels[0];
        const last = pixels[pixels.length - 1];
        return (
          <g key={run.id} data-wiring-run={run.id} className={selectedRunId === run.id ? 'is-selected' : ''}>
            <line className="lw-compiled-cord" x1={first.x} y1={first.y} x2={last.x} y2={last.y}/>
            <circle className="lw-compiled-endpoint" cx={first.x} cy={first.y} r="5"/>
            <circle className="lw-compiled-endpoint" cx={last.x} cy={last.y} r="5"/>
            <text className="lw-compiled-label" x={first.x} y={first.y - 9}>{multiWire ? `${outputNames.get(run.outputId)} · ${positions.get(run.id)}` : positions.get(run.id)}</text>
          </g>
        );
      })}
    </g>
  );
}
