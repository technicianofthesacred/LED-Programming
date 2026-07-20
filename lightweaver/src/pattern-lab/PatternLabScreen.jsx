import React from 'react';
import './pattern-lab.css';

const WORKFLOW = [
  ['01', 'Choose', 'Start from a pattern you already know.'],
  ['02', 'Sculpt', 'Shape color, movement, texture, and energy.'],
  ['03', 'Evolve', 'Stretch change naturally across five to fifteen minutes.'],
  ['04', 'Finish', 'Save a private draft before choosing where it goes.'],
];

function SculpturePlaceholder() {
  return (
    <svg className="plab-sculpture" viewBox="0 0 640 420" role="img" aria-label="Mapped sculpture preview placeholder">
      <defs>
        <linearGradient id="plab-path" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--text-faint)" />
          <stop offset="0.48" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--text-lo)" />
        </linearGradient>
      </defs>
      <circle className="plab-orbit" cx="320" cy="210" r="164" />
      <circle className="plab-orbit plab-orbit-inner" cx="320" cy="210" r="92" />
      <path className="plab-line" d="M320 45C353 115 443 123 480 210C413 230 397 322 320 375C287 305 197 297 160 210C227 190 243 98 320 45Z" />
      <path className="plab-line plab-line-secondary" d="M160 210C231 246 238 337 320 375C356 304 447 297 480 210C409 174 402 83 320 45C284 116 193 123 160 210Z" />
      <circle className="plab-node plab-node-one" cx="320" cy="45" r="5" />
      <circle className="plab-node plab-node-two" cx="480" cy="210" r="5" />
      <circle className="plab-node plab-node-three" cx="320" cy="375" r="5" />
      <circle className="plab-node plab-node-four" cx="160" cy="210" r="5" />
    </svg>
  );
}

function DisabledSlider({ label, value }) {
  return (
    <label className="plab-slider">
      <span>{label}</span>
      <output>{value}</output>
      <input type="range" min="0" max="100" value="50" disabled readOnly aria-label={label} />
    </label>
  );
}

export default function PatternLabScreen() {
  return (
    <main className="screen plab-screen" data-testid="pattern-lab-screen">
      <div className="plab-scroll">
        <header className="plab-header">
          <div>
            <span className="plab-kicker">Separate creative workspace</span>
            <h1>Pattern Lab</h1>
            <p>Build slow, detailed LED journeys from your existing patterns. Work here stays private until you explicitly save or send a finished look.</p>
          </div>
          <div className="plab-isolation" role="status">
            <span className="plab-isolation-mark" aria-hidden="true" />
            <span><strong>Isolated</strong>Your project and connected lights are unchanged.</span>
          </div>
        </header>

        <ol className="plab-workflow" aria-label="Pattern Lab workflow">
          {WORKFLOW.map(([number, title, description], index) => (
            <li key={title} className={index === 0 ? 'current' : ''}>
              <span className="plab-step-number">{number}</span>
              <span><strong>{title}</strong><small>{description}</small></span>
            </li>
          ))}
        </ol>

        <section className="plab-workspace" aria-labelledby="plab-empty-title">
          <div className="plab-preview">
            <div className="plab-preview-bar">
              <span>Artwork preview</span>
              <span className="plab-preview-state">No source selected</span>
            </div>
            <div className="plab-stage">
              <SculpturePlaceholder />
              <div className="plab-empty">
                <span className="plab-empty-rule" aria-hidden="true" />
                <h2 id="plab-empty-title">Begin with a pattern</h2>
                <p>Choose one of your existing looks, then Pattern Lab will make a private copy for longer, less repetitive evolution.</p>
                <button type="button" className="btn primary" disabled>Choose a pattern</button>
                <small>The pattern library connection arrives in the next build step.</small>
              </div>
            </div>
          </div>

          <aside className="plab-controls" aria-label="Pattern Lab controls">
            <div className="plab-control-heading">
              <span>Creative controls</span>
              <span>Waiting for a source</span>
            </div>
            <div className="plab-disabled-controls" aria-disabled="true">
              <DisabledSlider label="Color" value="Balanced" />
              <DisabledSlider label="Movement" value="Gentle" />
              <DisabledSlider label="Shape" value="Natural" />
              <DisabledSlider label="Texture" value="Soft" />
              <DisabledSlider label="Energy" value="Quiet" />
            </div>
            <div className="plab-evolution-preview">
              <span className="plab-section-label">Long Evolution</span>
              <div><strong>10 minutes</strong><span>Slow bloom</span></div>
              <div className="plab-timeline" aria-hidden="true"><span /></div>
              <p>Several gentle clocks will move at different rates, so the whole piece does not fall into a short loop.</p>
            </div>
            <div className="plab-actions">
              <button type="button" className="btn" disabled>Save draft</button>
              <button type="button" className="btn primary" disabled>Use in project</button>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
