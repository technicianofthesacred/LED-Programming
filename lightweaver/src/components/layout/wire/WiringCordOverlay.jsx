export function WiringCordOverlay({ compiled, selectedRunId }) {
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
            <text className="lw-compiled-label" x={first.x} y={first.y - 9}>{run.outputId} · {run.start + 1}</text>
          </g>
        );
      })}
    </g>
  );
}
