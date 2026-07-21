function formatMetric(value, digits = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : '0';
}

export default function PatternLabDiagnostics({ diagnostics, onPause, onFrameStep }) {
  if (!diagnostics) return null;

  const paused = Boolean(diagnostics.playback?.paused);
  const coordinates = diagnostics.coordinates || {};
  const performance = diagnostics.performance || {};
  const memory = diagnostics.memory || {};
  const entries = diagnostics.watcher?.entries || [];
  const darkness = diagnostics.darkness || [];

  return (
    <details className="plab-advanced plab-diagnostics" data-testid="pattern-lab-diagnostics">
      <summary>Diagnostics</summary>
      <div className="plab-diagnostic-playback">
        <span>Frame <strong>{diagnostics.playback?.frameIndex ?? 0}</strong></span>
        <div role="group" aria-label="Diagnostic playback controls">
          <button type="button" className="btn" aria-pressed={paused} onClick={() => onPause?.(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn" onClick={() => onFrameStep?.()}>
            Step one frame
          </button>
        </div>
      </div>

      <section aria-labelledby="plab-coordinate-heading">
        <h3 id="plab-coordinate-heading">Mapped coordinate</h3>
        <dl>
          <div><dt>X</dt><dd>{formatMetric(coordinates.x, 3)}</dd></div>
          <div><dt>Y</dt><dd>{formatMetric(coordinates.y, 3)}</dd></div>
          <div><dt>Strip</dt><dd>{formatMetric(coordinates.stripProgress, 3)}</dd></div>
          <div><dt>Radius</dt><dd>{formatMetric(coordinates.radius, 3)}</dd></div>
          <div><dt>Angle</dt><dd>{formatMetric(coordinates.angle, 3)}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="plab-performance-heading">
        <h3 id="plab-performance-heading">Performance and memory</h3>
        <dl>
          <div><dt>FPS</dt><dd>{formatMetric(performance.fps, 1)}</dd></div>
          <div><dt>Frame time</dt><dd>{formatMetric(performance.frameTimeMs, 2)} ms</dd></div>
          <div><dt>State</dt><dd>{formatMetric(memory.stateBytes)} bytes</dd></div>
          <div><dt>Framebuffer</dt><dd>{formatMetric(memory.framebufferBytes)} bytes</dd></div>
        </dl>
      </section>

      <section aria-labelledby="plab-watcher-heading">
        <h3 id="plab-watcher-heading">State watcher</h3>
        {entries.length > 0 ? (
          <dl>{entries.map(entry => <div key={entry.path}><dt>{entry.path}</dt><dd>{String(entry.value)}</dd></div>)}</dl>
        ) : <p>No generator state is exposed for this frame.</p>}
        {diagnostics.watcher?.truncated && <p>Showing the first {diagnostics.watcher.maxEntries} bounded entries.</p>}
      </section>

      <section aria-labelledby="plab-darkness-heading">
        <h3 id="plab-darkness-heading">Why is this dark?</h3>
        {darkness.length > 0 ? (
          <ul>
            {darkness.map(item => (
              <li key={item.code}>
                <strong>{item.message}</strong> {item.action}
              </li>
            ))}
          </ul>
        ) : <p>No known mask, brightness, gamma, power, output, or target issue was detected.</p>}
      </section>
    </details>
  );
}
