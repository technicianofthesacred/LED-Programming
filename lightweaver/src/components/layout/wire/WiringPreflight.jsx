export function WiringPreflight({ compiled, locked, canLock, onToggleLock, mutationError }) {
  const ready = compiled.sendReady;
  const plainMessage = message => String(message || '').replace(/run-[a-z0-9-]+/gi, 'a strip').replace(/\bout\d+\b/gi, 'an output');
  return (
    <section className={`lw-wiring-preflight${compiled.ok ? '' : ' has-errors'}`} aria-live="polite">
      <div className="lw-wire-section-title">
        <span>{ready ? 'Ready to install' : 'Physical check required'}</span>
        <strong data-testid="wiring-total-pixels">{compiled.totalPixels} pixels</strong>
      </div>
      {mutationError && <p className="lw-wiring-error">{mutationError}</p>}
      {compiled.errors.map(item => <p className="lw-wiring-error" key={`${item.code}-${item.runId || ''}`}>{plainMessage(item.message)}</p>)}
      {!compiled.ok ? null : <p>{ready ? 'Physical mapping is confirmed.' : locked ? 'Unlock to change the physical mapping.' : 'Check each strip boundary before installation.'}</p>}
      {(locked || canLock) && <button className="btn" onClick={onToggleLock}>{locked ? 'Unlock wiring' : 'Lock wiring'}</button>}
    </section>
  );
}
