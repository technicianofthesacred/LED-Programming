import { Fragment } from 'react';
import { UiCard } from '../../ui/UiCard.jsx';
import '../../../styles/lw-wire.css';

const MAX_TICKS = 10;
// Diagram copy talks about wires (redesign change 6), keyed by the same A/B
// letters the mapping lanes use.
const wireLabel = index => `Wire ${String.fromCharCode(65 + index)}`;

function runPixelCount(run) {
  if (!run) return 0;
  if (run.type === 'inactive') return Math.max(0, Math.trunc(Number(run.count) || 0));
  if (run.type !== 'strip') return 0;
  return Math.abs(run.source.to - run.source.from) + 1;
}

function runName(run, stripsById) {
  if (run.type === 'inactive') return 'skipped pixels';
  return stripsById.get(run.source.stripId)?.name || 'Unnamed strip';
}

function rowCaption(row) {
  if (!row.runs.length) return `${row.label} · no strips yet`;
  const checked = row.runs.every(run => run.verified) ? ' · checked on the LEDs' : '';
  return `${row.label} → ${row.names.join(' → ')} · ${row.pixels} px · first LED blue, last LED red${checked}`;
}

/**
 * WiringMiniDiagram — small always-visible card → wire → strip schematic
 * (redesign change 7). Reads the same `wiring` object WireModePanel already
 * holds; verified runs tint green, and the first/last LED markers mirror the
 * blue-first / red-last bench check.
 */
export function WiringMiniDiagram({ wiring, stripsById }) {
  const runsById = new Map(wiring.runs.map(run => [run.id, run]));
  const rows = wiring.outputs.map((output, index) => {
    const runs = output.runIds
      .map(id => runsById.get(id))
      .filter(run => run && run.type !== 'cable');
    return {
      output,
      label: wireLabel(index),
      runs,
      pixels: runs.reduce((sum, run) => sum + runPixelCount(run), 0),
      names: runs.map(run => runName(run, stripsById)),
    };
  });
  return (
    <UiCard>
      <div className="lww-diagram" data-testid="wiring-mini-diagram">
        {rows.map(row => (
          <div key={row.output.id} className="lww-diagram-out">
            <div className="lww-diagram-row" aria-hidden="true">
              <span className="lww-diagram-card">CARD</span>
              <span className="lww-diagram-wire" />
              {!row.runs.length && <span className="lww-diagram-empty">no strips yet</span>}
              {row.runs.map((run, runIndex) => {
                const count = runPixelCount(run);
                const ticks = Math.max(1, Math.min(MAX_TICKS, count));
                return (
                  <Fragment key={run.id}>
                    {runIndex > 0 && <span className="lww-diagram-gap" />}
                    <span
                      className={`lww-diagram-strip${run.verified ? ' is-verified' : ''}${run.type === 'inactive' ? ' is-inactive' : ''}`}
                    >
                      {Array.from({ length: ticks }, (_, tick) => {
                        const isFirst = runIndex === 0 && tick === 0;
                        const isLast = runIndex === row.runs.length - 1 && tick === ticks - 1;
                        return <i key={tick} className={isFirst ? 'is-first' : isLast ? 'is-last' : undefined} />;
                      })}
                    </span>
                  </Fragment>
                );
              })}
            </div>
            <p className="lww-diagram-cap">{rowCaption(row)}</p>
          </div>
        ))}
      </div>
    </UiCard>
  );
}

export default WiringMiniDiagram;
