export function WiringPlanSummary({ wiring, strips }) {
  const stripsById = new Map(strips.map(strip => [strip.id, strip]));
  const runsById = new Map(wiring.runs.map(run => [run.id, run]));
  const groups = wiring.outputs
    .map(output => {
      const seen = new Set();
      const orderedStrips = output.runIds
        .map(id => runsById.get(id))
        .filter(run => run?.type === 'strip')
        .map(run => stripsById.get(run.source.stripId))
        .filter(strip => {
          if (!strip || seen.has(strip.id)) return false;
          seen.add(strip.id);
          return true;
        });
      return { output, strips: orderedStrips };
    })
    .filter(group => group.strips.length > 0);

  return (
    <div className="lww-plan-summary" data-testid="test-install-plan-summary">
      {groups.map(({ output, strips: groupStrips }) => (
        <section key={output.id} className="la-gpio-group">
          <div className="la-gpio-group-head">
            <span>GPIO {output.pin}</span>
            <span>first → last</span>
          </div>
          {groupStrips.map((strip, index) => (
            <div
              key={strip.id}
              className="la-strip-row lww-plan-strip"
              data-testid="test-install-strip-row"
            >
              <span className="la-wire-n">{String(index + 1).padStart(2, '0')}</span>
              <span
                className="layer-swatch"
                aria-hidden="true"
                style={{ borderRadius: '50%', background: strip.color }}
              />
              <span className="layer-name">{strip.name}</span>
              <span className="layer-len">{strip.pixelCount} LEDs</span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
