export function WiringPreflight({ compiled, locked, onToggleLock, mutationError }) {
  const ready = compiled.sendReady;
  return (
    <section className={`lw-wiring-preflight${compiled.ok ? '' : ' has-errors'}`} aria-live="polite">
      <div className="lw-wire-section-title">
        <span>Compiler preflight</span>
        <strong data-testid="wiring-total-pixels">{compiled.totalPixels} pixels</strong>
      </div>
      {mutationError && <p className="lw-wiring-error">{mutationError}</p>}
      {compiled.errors.map(item => <p className="lw-wiring-error" key={`${item.code}-${item.runId || ''}`}>{item.message}</p>)}
      {compiled.warnings.map((item, index) => <p className="lw-wiring-warning" key={`${item.code}-${index}`}>{item.message}</p>)}
      <p>{ready ? 'Verified and ready to send.' : locked ? 'Locked, but verification is incomplete.' : 'Review the physical route, then lock it before sending.'}</p>
      <button className="btn" onClick={onToggleLock}>{locked ? 'Unlock wiring' : 'Lock wiring'}</button>
      <small>{locked ? 'Unlocking allows physical changes and clears send readiness.' : 'Locking confirms this wiring matches the assembled installation.'}</small>
    </section>
  );
}
