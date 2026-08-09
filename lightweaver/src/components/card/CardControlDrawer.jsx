import React, { useEffect, useRef, useState } from 'react';
import { readCardPatternsFromCard, readCardZonesFromCard, pushLivePreviewToCard } from '../../lib/cardLiveControl.js';
import {
  applyCustomerControlAcknowledgement,
  beginCustomerControl,
  createCardCustomerControls,
  normalizeCardCustomerControls,
} from '../../lib/cardCustomerControls.js';

function percent(value) {
  return Math.round(Number(value || 0) * 100);
}

export function CardControlDrawer({ open, link, host, onClose, onAdvanced }) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const [controls, setControls] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    restoreFocusRef.current = document.activeElement;
    setControls(null);
    setLoadError('');
    Promise.all([
      readCardZonesFromCard({ host, timeoutMs: 1800 }),
      readCardPatternsFromCard({ host, timeoutMs: 1800 }),
    ]).then(([zones, patterns]) => {
      if (!active) return;
      setControls(createCardCustomerControls(normalizeCardCustomerControls(zones, patterns)));
      window.setTimeout(() => panelRef.current?.focus(), 0);
    }).catch(error => {
      if (active) setLoadError(error?.message || 'Studio could not read the card controls.');
    });
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      active = false;
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus?.();
    };
  }, [host, onClose, open, reloadKey]);

  if (!open) return null;
  const view = controls?.view;
  const runControl = patch => {
    if (!controls?.view || controls.pending) return;
    const optimistic = beginCustomerControl(controls, patch);
    setControls(optimistic);
    const look = { ...optimistic.view.look, blackout: optimistic.view.blackout };
    pushLivePreviewToCard(look, {
      host,
      expectedCardId: link.card?.id || '',
      preferBridge: link.transport === 'bridge',
      latestOnly: false,
      autoDiscover: false,
      revision: optimistic.command.id,
    }).then(response => {
      setControls(current => applyCustomerControlAcknowledgement(current, optimistic.command.id, response));
    }).catch(error => {
      setControls(current => applyCustomerControlAcknowledgement(current, optimistic.command.id, error));
    });
  };
  const cyclePattern = direction => {
    if (!view?.patterns?.length) return;
    const current = Math.max(0, view.patterns.findIndex(pattern => pattern.id === view.activePatternId));
    const index = (current + direction + view.patterns.length) % view.patterns.length;
    runControl({ patternId: view.patterns[index].id });
  };

  return (
    <div className="card-control-layer" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside
        id="card-control-drawer"
        className="card-control-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${link.card?.name || 'Lightweaver'} controls`}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="card-control-head">
          <div>
            <p>Connected card</p>
            <h2>{link.card?.name || 'Lightweaver'}</h2>
            <span>{link.state === 'connected-bridge' ? 'Connected through card page' : 'Connected on local network'}</span>
          </div>
          <button type="button" className="card-connection-close" onClick={onClose} aria-label="Close card controls">×</button>
        </header>

        {loadError ? <div className="card-control-error" role="alert"><p>{loadError}</p><button type="button" className="btn" onClick={() => setReloadKey(key => key + 1)}>Try again</button></div> : null}
        {!controls && !loadError ? <p className="card-control-loading" role="status">Reading the card controls…</p> : null}
        {view ? <div className="card-control-body">
          <section aria-labelledby="card-pattern-heading">
            <h3 id="card-pattern-heading">Pattern</h3>
            <div className="card-pattern-select">
              <button type="button" onClick={() => cyclePattern(-1)} disabled={Boolean(controls.pending)} aria-label="Previous pattern">Previous</button>
              <select aria-label="Pattern" value={view.activePatternId} disabled={Boolean(controls.pending)} onChange={event => runControl({ patternId: event.target.value })}>
                {view.patterns.map(pattern => <option key={pattern.id} value={pattern.id}>{pattern.label}</option>)}
              </select>
              <button type="button" onClick={() => cyclePattern(1)} disabled={Boolean(controls.pending)} aria-label="Next pattern">Next</button>
            </div>
          </section>

          <section className="card-control-sliders" aria-label="Pattern controls">
            <label>Brightness <output>{percent(view.look.brightness)}%</output><input aria-label="Brightness" type="range" min="0" max="100" value={percent(view.look.brightness)} disabled={Boolean(controls.pending)} onChange={event => runControl({ brightness: Number(event.target.value) / 100 })} /></label>
            <label>Speed <output>{view.look.speed.toFixed(2)}×</output><input aria-label="Speed" type="range" min="0.05" max="3" step="0.05" value={view.look.speed} disabled={Boolean(controls.pending)} onChange={event => runControl({ speed: Number(event.target.value) })} /></label>
            <label>Hue shift <output>{view.look.hueShift}</output><input aria-label="Hue shift" type="range" min="-128" max="128" value={view.look.hueShift} disabled={Boolean(controls.pending)} onChange={event => runControl({ hueShift: Number(event.target.value) })} /></label>
          </section>

          <section className="card-control-custom" aria-labelledby="card-custom-heading">
            <h3 id="card-custom-heading">Custom color</h3>
            <label>Hue <output>{view.look.customHue}</output><input aria-label="Custom hue" type="range" min="0" max="255" value={view.look.customHue} disabled={Boolean(controls.pending)} onChange={event => runControl({ customHue: Number(event.target.value) })} /></label>
            <label>Saturation <output>{view.look.customSaturation}</output><input aria-label="Custom saturation" type="range" min="0" max="255" value={view.look.customSaturation} disabled={Boolean(controls.pending)} onChange={event => runControl({ customSaturation: Number(event.target.value) })} /></label>
            <label className="card-control-toggle"><input aria-label="Breathe" type="checkbox" checked={view.look.customBreathe} disabled={Boolean(controls.pending)} onChange={event => runControl({ customBreathe: event.target.checked })} /> Breathe</label>
            <label className="card-control-toggle"><input aria-label="Drift" type="checkbox" checked={view.look.customDrift} disabled={Boolean(controls.pending)} onChange={event => runControl({ customDrift: event.target.checked })} /> Drift</label>
          </section>

          {controls.failure ? <div className="card-control-error" role="alert"><p>{controls.failure.message}</p><button type="button" className="btn" onClick={() => runControl(controls.retry)}>Retry</button></div> : null}
          <footer className="card-control-actions">
            <button type="button" className="btn" onClick={() => onAdvanced(view.activePatternId)}>Advanced editing</button>
            <button type="button" className={view.blackout ? 'btn primary' : 'btn'} onClick={() => runControl({ blackout: !view.blackout })} disabled={Boolean(controls.pending)}>{view.blackout ? 'Restore' : 'Blackout'}</button>
          </footer>
        </div> : null}
      </aside>
    </div>
  );
}
