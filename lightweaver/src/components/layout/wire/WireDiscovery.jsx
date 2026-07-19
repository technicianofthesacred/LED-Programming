import { useEffect, useRef, useState } from 'react';
import { discoverCardWiring } from '../../../lib/cardWiringSafety.js';

export function WireDiscovery({ outputs = [], cardHost, onPinConfirmed, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [outputId, setOutputId] = useState(outputs[0]?.id || '');
  const [batch, setBatch] = useState(0);
  const [assignments, setAssignments] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const discoveryActiveRef = useRef(false);
  const stopPromiseRef = useRef(null);

  const stopCardDiscovery = () => {
    if (!discoveryActiveRef.current) return Promise.resolve();
    if (stopPromiseRef.current) return stopPromiseRef.current;
    stopPromiseRef.current = discoverCardWiring({ stop: true }, { host: cardHost })
      .then(response => {
        discoveryActiveRef.current = false;
        return response;
      })
      .finally(() => { stopPromiseRef.current = null; });
    return stopPromiseRef.current;
  };

  useEffect(() => () => {
    if (discoveryActiveRef.current) void stopCardDiscovery().catch(() => {});
  }, [cardHost]);

  const runBatch = async nextBatch => {
    setLoading(true);
    setStatus('Testing safe LED ports…');
    // The request may be accepted immediately before its reboot drops the
    // response, so treat discovery as active until an explicit stop succeeds.
    discoveryActiveRef.current = true;
    try {
      const response = await discoverCardWiring({ batch: nextBatch }, { host: cardHost });
      setAssignments(response.assignments);
      setBatch(nextBatch);
      setStatus('Choose the color you see on the real LEDs.');
    } catch (error) {
      setAssignments([]);
      setStatus(error.message || 'The card could not start wire discovery.');
    } finally {
      setLoading(false);
    }
  };

  const choose = async assignment => {
    setLoading(true);
    setStatus('Saving that port and returning to the working lights…');
    try {
      await stopCardDiscovery();
      onPinConfirmed?.(outputId, assignment.pin);
      setStatus(`${outputs.find(output => output.id === outputId)?.name || 'LED port'} uses GPIO ${assignment.pin}. Test its LED count next.`);
      setAssignments([]);
    } catch (error) {
      setStatus(error.message || 'The card could not leave wire discovery.');
    } finally {
      setLoading(false);
    }
  };

  const close = async () => {
    setLoading(true);
    setStatus('Restoring the working lights…');
    try {
      await stopCardDiscovery();
      setAssignments([]);
      setOpen(false);
    } catch (error) {
      setStatus(error.message || 'The card could not leave wire discovery. Use Recover lights to restore it.');
    } finally {
      setLoading(false);
    }
  };

  if (!open) return <button className="btn lw-find-wire" disabled={disabled} onClick={() => { setOpen(true); void runBatch(0); }}>Find my LED wire</button>;

  return (
    <section className="lw-wire-discovery" aria-label="Find my LED wire">
      <header><div><span className="lw-bench-kicker">Guided test</span><strong>Which port lights your LEDs?</strong></div><button className="btn btn-ghost" aria-label="Close wire finder" disabled={loading} onClick={close}>Close</button></header>
      {outputs.length > 1 && <label>Testing
        <select value={outputId} onChange={event => setOutputId(event.target.value)}>{outputs.map((output, index) => <option key={output.id} value={output.id}>LED Port {index + 1}</option>)}</select>
      </label>}
      <p>Lightweaver tests up to four safe ports. Tap the color that appears on your strip.</p>
      <div className="lw-wire-discovery-colors">
        {assignments.map(assignment => <button key={assignment.pin} disabled={loading} style={{ '--wire-color': assignment.color }} onClick={() => choose(assignment)}><i/>{assignment.label || assignment.color}<small>GPIO {assignment.pin}</small></button>)}
      </div>
      <p className="lw-wire-discovery-status">{status}</p>
      {!loading && assignments.length > 0 && <button className="btn" onClick={() => runBatch(batch + 1)}>None of these lit</button>}
      {!loading && assignments.length === 0 && status.includes('could not') && <ul><li>Check LED power.</li><li>Connect card and LED grounds together.</li><li>Use the strip’s DATA IN end.</li><li>Reseat the data connector.</li></ul>}
    </section>
  );
}
