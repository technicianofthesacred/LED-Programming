import React, { useEffect, useRef } from 'react';
import { buildProductionDiagnostic } from '../../lib/productionRecovery.js';

function answer(value) {
  return value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'Not confirmed';
}

export function ProductionRecovery({ recovery, phase, firmwareTarget, hardware, platform, onAction }) {
  const actionRef = useRef(null);
  useEffect(() => { actionRef.current?.focus(); }, [recovery?.supportCode]);
  if (!recovery) return null;

  function exportDiagnostic() {
    const diagnostic = buildProductionDiagnostic({
      app: 'Lightweaver', version: '0.1.0', os: platform?.os || 'unknown', arch: platform?.arch || 'unknown',
      supportCode: recovery.supportCode, phase, firmwareTarget,
      vid: hardware?.usbVendorId, pid: hardware?.usbProductId,
    });
    const blob = new Blob([`${JSON.stringify(diagnostic, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `lightweaver-support-${recovery.supportCode.toLowerCase()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <section className="prod-recovery" role="region" aria-label="Safe recovery" aria-live="assertive">
    <div className="prod-recovery-head">
      <div><span className="prod-kicker">Safe recovery</span><h3>Studio stopped safely</h3></div>
      <code>{recovery.supportCode}</code>
    </div>
    <p>{recovery.whatHappened}</p>
    <dl>
      <div><dt>Card changed?</dt><dd>{answer(recovery.cardChanged)}</dd></div>
      <div><dt>USB released?</dt><dd>{answer(recovery.usbReleased)}</dd></div>
    </dl>
    <div className="prod-recovery-actions">
      <button ref={actionRef} className="btn primary prod-recovery-primary" type="button" onClick={() => onAction(recovery.action.id)}>{recovery.action.label}</button>
      <button className="btn" type="button" onClick={exportDiagnostic}>Export support details</button>
    </div>
    <small>Support details exclude card, artwork, worker, network, and raw error data.</small>
  </section>;
}
