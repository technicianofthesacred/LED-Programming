import React from 'react';
import { downloadTextFile } from '../../lib/downloadFile.js';
import { productionRecordsCsv, productionRecordsJson, readProductionRecords } from '../../lib/productionRecords.js';

export function ProductionPassRecord({ refreshKey = 0 }) {
  const records = readProductionRecords();
  const latest = records.at(-1);
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <section className="prod-records" aria-labelledby="prod-records-heading" data-refresh={refreshKey}>
      <div className="prod-section-head">
        <div><span className="prod-kicker">This browser</span><h2 id="prod-records-heading">Pass records</h2></div>
        <span className="prod-count">{records.length}</span>
      </div>
      <p className="prod-local-note">Unexported records exist only in this browser. Export them before changing computers or clearing browser data.</p>
      {latest ? <p className="prod-latest"><strong>Latest:</strong> {latest.artwork} · {latest.cardId} · {new Date(latest.passedAt).toLocaleString()}</p> : <p className="prod-muted">No completed artwork passes on this computer yet.</p>}
      <div className="prod-record-actions">
        <button className="btn" type="button" disabled={!records.length} onClick={() => downloadTextFile(`lightweaver-production-${stamp}.json`, productionRecordsJson(), { type: 'application/json' })}>Export JSON</button>
        <button className="btn" type="button" disabled={!records.length} onClick={() => downloadTextFile(`lightweaver-production-${stamp}.csv`, productionRecordsCsv(), { type: 'text/csv' })}>Export CSV</button>
      </div>
    </section>
  );
}
