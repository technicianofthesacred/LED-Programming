import { deriveWiringAssembly } from '../../../lib/wiringAssembly.js';

export function WiringAssemblyMap({ wiring, compiled, strips, physicalScale, onClose }) {
  const assembly = deriveWiringAssembly({ wiring, compiled, strips, physicalScale });
  if (!assembly.ok) return <section className="lw-assembly-map"><p className="lw-wiring-error">{assembly.errors[0]?.message}</p></section>;
  return (
    <section className="lw-assembly-map" data-testid="wiring-assembly-map">
      <header><div><small>LIGHTWEAVER ASSEMBLY MAP</small><h3>Controller at {assembly.controllerAnchor ? `${Math.round(assembly.controllerAnchor.x)}, ${Math.round(assembly.controllerAnchor.y)}` : 'artwork origin'}</h3><p>{assembly.totalPixels} addressed pixels{assembly.relativeLengths ? ' · jumper lengths are relative' : ''}</p></div><div className="lw-assembly-actions"><button className="btn" onClick={() => window.print()}>Print assembly map</button><button className="btn" onClick={onClose}>Close</button></div></header>
      {assembly.outputs.map(output => <article key={output.id} className="lw-assembly-output" data-testid="assembly-output"><h4>{output.label} · GPIO {output.pin}</h4><p>Addresses {output.start}–{output.start + output.count - 1} · {output.count} pixels · {output.verified ? 'Verified' : 'Not verified'}</p><ol>{output.runs.map(run => <li key={run.id}><strong>{run.label}</strong><span>{run.addressRange ? `LED ${run.addressRange[0]}–${run.addressRange[1]} · ${run.count}` : 'Zero-address separator'}</span>{run.direction && <span>{run.direction}{run.seamLed != null ? ` · seam LED ${run.seamLed}` : ''}</span>}{run.jumper && <span>Jumper → {run.jumper.toRunId} · {run.jumper.lengthLabel}</span>}<small>{run.verified ? 'Verified' : 'Not verified'}</small></li>)}</ol></article>)}
    </section>
  );
}
