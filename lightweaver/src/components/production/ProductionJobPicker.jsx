import React, { useEffect, useId, useRef, useState } from 'react';
import {
  MAX_PRODUCTION_JOB_BYTES,
  loadProductionJobFromIndexEntry,
  loadProductionJobIndex,
  parseProductionJobPackage,
} from '../../lib/productionJobPackage.js';

export function ProductionJobPicker({ selectedJob, onSelect, disabled = false, requestedCode = '' }) {
  const [index, setIndex] = useState({ state: 'loading', jobs: [], error: '' });
  const [code, setCode] = useState('');
  const [jobFile, setJobFile] = useState(null);
  const [signatureFile, setSignatureFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef(null);
  const requestedRef = useRef('');
  const selectionRef = useRef(0);
  const selectingRef = useRef(false);
  const codeId = useId();

  useEffect(() => {
    let active = true;
    loadProductionJobIndex()
      .then(value => { if (active) setIndex({ state: 'ready', jobs: value.jobs, error: '' }); })
      .catch(reason => { if (active) setIndex({ state: 'error', jobs: [], error: reason?.message || String(reason) }); });
    return () => { active = false; };
  }, []);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => () => { selectionRef.current += 1; }, []);

  useEffect(() => {
    const wanted = requestedCode.trim().toLowerCase();
    if (!wanted || selectedJob || index.state !== 'ready' || requestedRef.current === wanted) return;
    requestedRef.current = wanted;
    const entry = index.jobs.find(item => item.jobId.toLowerCase() === wanted || item.label.toLowerCase() === wanted);
    if (!entry) { setError(`Job code ${requestedCode} was not found in the verified workshop list.`); return; }
    void selectEntry(entry);
  }, [index, onSelect, requestedCode, selectedJob]);

  async function selectEntry(entry) {
    if (disabled || selectingRef.current) return;
    selectingRef.current = true;
    const attempt = selectionRef.current + 1;
    selectionRef.current = attempt;
    setBusy(true); setError('');
    try {
      const verified = await loadProductionJobFromIndexEntry(entry);
      if (selectionRef.current !== attempt) return;
      await onSelect(verified);
    } catch (reason) {
      if (selectionRef.current === attempt) setError(reason?.message || 'That production job could not be verified.');
    } finally { if (selectionRef.current === attempt) { selectingRef.current = false; setBusy(false); } }
  }

  function loadCode(event) {
    event.preventDefault();
    const wanted = code.trim().toLowerCase();
    const entry = index.jobs.find(item => item.jobId.toLowerCase() === wanted || item.label.toLowerCase() === wanted);
    if (!entry) { setError('Job code not found. Check the label and try again.'); return; }
    void selectEntry(entry);
  }

  async function loadFiles(event) {
    event.preventDefault();
    if (disabled || selectingRef.current) return;
    if (!jobFile || !signatureFile) { setError('Choose both the job file and its matching signature file.'); return; }
    if (jobFile.size > MAX_PRODUCTION_JOB_BYTES || signatureFile.size > 8 * 1024) { setError('The selected job or signature file is larger than the safe import limit.'); return; }
    const attempt = selectionRef.current + 1;
    selectionRef.current = attempt;
    selectingRef.current = true;
    setBusy(true); setError('');
    try {
      const [bytes, signatureText] = await Promise.all([jobFile.arrayBuffer(), signatureFile.text()]);
      const signature = JSON.parse(signatureText);
      const verified = await parseProductionJobPackage(bytes, { trust: { kind: 'external', signature } });
      if (selectionRef.current === attempt) await onSelect(verified);
    } catch (reason) { if (selectionRef.current === attempt) setError(reason?.message || 'The selected files could not be verified.'); }
    finally { if (selectionRef.current === attempt) { selectingRef.current = false; setBusy(false); } }
  }

  if (selectedJob) {
    return (
      <section className="prod-job-selected" aria-labelledby="prod-selected-job">
        <div>
          <span className="prod-kicker">Verified production job</span>
          <h2 id="prod-selected-job">{selectedJob.label}</h2>
          <p>{selectedJob.artwork} · batch {selectedJob.batch}</p>
        </div>
        <dl>
          <div><dt>Job</dt><dd>{selectedJob.jobId}</dd></div>
          <div><dt>Revision</dt><dd>{selectedJob.project.revision}</dd></div>
          <div><dt>Outputs</dt><dd>{selectedJob.expectedOutputs.length}</dd></div>
        </dl>
      </section>
    );
  }

  return (
    <section className="prod-picker" aria-labelledby="prod-pick-heading" aria-busy={busy}>
      <div className="prod-section-head">
        <div><span className="prod-kicker">Step 1</span><h2 id="prod-pick-heading">Choose the artwork job</h2></div>
        <span className="prod-muted">Verified jobs only</span>
      </div>
      {index.state === 'loading' && <p role="status">Loading workshop jobs…</p>}
      {index.state === 'ready' && index.jobs.length > 0 && (
        <div className="prod-job-grid">
          {index.jobs.map(entry => <button className="prod-job-option" type="button" disabled={disabled || busy} key={entry.digest} onClick={() => selectEntry(entry)}><strong>{entry.label}</strong><span>{entry.jobId}</span></button>)}
        </div>
      )}
      {index.state === 'ready' && index.jobs.length === 0 && <p>No workshop jobs are published yet. Use a signed job file below.</p>}
      {index.state === 'error' && <p className="prod-inline-warn">The job list is unavailable. A verified signed file still works.</p>}

      <div className="prod-fallbacks">
        <form onSubmit={loadCode}>
          <label htmlFor={codeId}>Job code</label>
          <div className="prod-inline-control"><input id={codeId} value={code} onChange={event => setCode(event.target.value)} autoCapitalize="none" autoCorrect="off" disabled={disabled || busy} /><button className="btn" disabled={!code.trim() || disabled || busy}>Find job</button></div>
          <small>Use the code printed beside the artwork when a QR camera is unavailable.</small>
        </form>
        <form onSubmit={loadFiles}>
          <label>Verified job files</label>
          <div className="prod-file-row">
            <label className="btn prod-file">Job file<input aria-label="Production job file" type="file" accept=".lwjob.json,application/json" onChange={event => setJobFile(event.target.files?.[0] || null)} disabled={disabled || busy} /></label>
            <label className="btn prod-file">Signature<input aria-label="Production job signature file" type="file" accept=".sig.json,application/json" onChange={event => setSignatureFile(event.target.files?.[0] || null)} disabled={disabled || busy} /></label>
            <button className="btn" disabled={!jobFile || !signatureFile || disabled || busy}>Verify files</button>
          </div>
          <small>{jobFile?.name || 'No job file selected'} · {signatureFile?.name || 'No signature selected'}</small>
        </form>
      </div>
      {error && <p ref={errorRef} tabIndex={-1} className="prod-error" role="alert">{error}</p>}
    </section>
  );
}
