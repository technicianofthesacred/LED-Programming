export function WiringPreflight({ compiled, mutationError }) {
  const plainMessage = message => String(message || '').replace(/run-[a-z0-9-]+/gi, 'a strip').replace(/\bout\d+\b/gi, 'an output');
  // Only renders when there is something actionable — a clean compile adds nothing to read.
  if (!mutationError && !compiled.errors.length) return null;
  return (
    <section className="lw-wiring-preflight has-errors" aria-live="polite">
      {mutationError && <p className="lw-wiring-error">{mutationError}</p>}
      {compiled.errors.map(item => <p className="lw-wiring-error" key={`${item.code}-${item.runId || ''}`}>{plainMessage(item.message)}</p>)}
    </section>
  );
}
