import { useState, useEffect } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { useMidi } from '../hooks/useMidi.js';

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div className="lw-sec-header"><span>{title}</span></div>
      {children}
    </div>
  );
}

function Row({ label, children, hint }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <span style={{ color: 'var(--text-2)', fontSize: 11, minWidth: 90 }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
      {hint && <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{hint}</span>}
    </div>
  );
}

function Dot({ color }) {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }}/>;
}

const LS_SEGS_KEY = 'lw_wled_segments';
function loadSegments() { try { return JSON.parse(localStorage.getItem(LS_SEGS_KEY) || '{}'); } catch { return {}; } }

export function DevicesPanel({ onClose }) {
  const { wledIp, setWledIp, wledConnected, wledConnect, wledDisconnect, strips } = useProject();
  const [scanResults, setScanResults] = useState([]);
  const [scanning,    setScanning]    = useState(false);
  const [pingMs,      setPingMs]      = useState(null);
  const [segMap, setSegMap] = useState(loadSegments); // { stripId: segIndex }
  const [pushStatus, setPushStatus] = useState('');

  const [wledInfo, setWledInfo] = useState(null);

  const midi = useMidi({
    onCC: (ch, cc, val) => console.debug('[MIDI CC]', ch, cc, val),
  });

  // Fetch WLED device info
  const fetchWledInfo = async () => {
    if (!wledIp) return;
    try {
      const r = await fetch(`http://${wledIp}/json/info`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) setWledInfo(await r.json());
    } catch {}
  };

  useEffect(() => {
    if (wledConnected && wledIp) fetchWledInfo();
    else setWledInfo(null);
  }, [wledConnected, wledIp]);

  const sendTestPattern = async () => {
    if (!wledIp) return;
    try {
      // Chase pattern: send rainbow preset
      await fetch(`http://${wledIp}/json/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ on: true, bri: 200, seg: [{ id: 0, fx: 9, col: [[255,0,0]] }] }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) { console.warn('Test pattern failed:', e); }
  };

  // Ping WLED device when connected
  useEffect(() => {
    if (!wledConnected || !wledIp) { setPingMs(null); return; }
    let cancelled = false;
    const doPing = async () => {
      const t0 = performance.now();
      try {
        await fetch(`http://${wledIp}/json/info`, { method: 'GET', signal: AbortSignal.timeout(2000) });
        if (!cancelled) setPingMs(Math.round(performance.now() - t0));
      } catch { if (!cancelled) setPingMs(null); }
    };
    doPing();
    const iv = setInterval(doPing, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [wledConnected, wledIp]);

  // Subnet scan — tries common WLED IPs on the local /24 via HTTP
  const handleScan = async () => {
    setScanning(true);
    setScanResults([]);
    // Best-effort: ping x.x.x.1-254 on common ports
    const subnet = wledIp ? wledIp.split('.').slice(0, 3).join('.') : '192.168.1';
    const candidates = [];
    for (let i = 1; i <= 254; i++) candidates.push(`${subnet}.${i}`);
    const found = [];
    await Promise.allSettled(
      candidates.map(async (ip) => {
        try {
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 800);
          const r = await fetch(`http://${ip}/json/info`, { signal: ctrl.signal });
          clearTimeout(timeout);
          if (r.ok) {
            const info = await r.json();
            found.push({ ip, name: info.name || 'WLED', leds: info.leds?.count, ver: info.ver });
          }
        } catch { /* unreachable */ }
      })
    );
    setScanResults(found);
    setScanning(false);
  };

  return (
    <div className="lw-modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="lw-modal" style={{ width: 480, maxHeight: '80vh', overflowY: 'auto' }}>
        <div className="lw-modal-header">
          <span>Devices</span>
          <button className="lw-modal-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '0 20px 20px' }}>
          <Section title="WLED Controller">
            <Row label="Status">
              <Dot color={wledConnected ? 'oklch(72% 0.18 155)' : 'oklch(64% 0.20 25)'}/>
              <span style={{ fontSize: 12 }}>{wledConnected ? 'Connected' : 'Disconnected'}</span>
              {wledConnected && pingMs !== null && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{pingMs} ms</span>}
            </Row>
            <Row label="IP Address">
              <input
                className="lw-search-input"
                style={{ flex: 1 }}
                value={wledIp}
                onChange={e => setWledIp(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && wledConnect()}
                placeholder="192.168.x.x"
                disabled={wledConnected}
              />
              <button className="btn" onClick={wledConnected ? wledDisconnect : wledConnect}>
                {wledConnected ? 'Disconnect' : 'Connect'}
              </button>
            </Row>
            <Row label="Network scan">
              <button className="btn btn-ghost" onClick={handleScan} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Scan LAN'}
              </button>
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {scanning ? 'Checking subnet…' : scanResults.length > 0 ? `${scanResults.length} found` : 'searches local /24'}
              </span>
            </Row>
            {wledConnected && (
              <Row label="Test pattern">
                <button className="btn btn-ghost" style={{ fontSize: 10 }} onClick={sendTestPattern}>
                  Send Rainbow
                </button>
                <span style={{ fontSize: 10, color: 'var(--text-4)' }}>Sends rainbow chase to verify connection</span>
              </Row>
            )}
            {wledInfo && (
              <Row label="Device info">
                <span style={{ fontSize: 11, fontFamily: 'var(--mono-font)' }}>{wledInfo.name}</span>
                <span style={{ fontSize: 10, color: 'var(--text-3)' }}>v{wledInfo.ver}</span>
                <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{wledInfo.leds?.count} LEDs · {wledInfo.leds?.fps} fps</span>
              </Row>
            )}
            {scanResults.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {scanResults.map(d => (
                  <div key={d.ip}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
                             fontSize: 12, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => { setWledIp(d.ip); wledConnect(); }}
                  >
                    <Dot color="oklch(74% 0.13 210)"/>
                    <span style={{ flex: 1 }}>{d.name}</span>
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono-font)' }}>{d.ip}</span>
                    {d.leds && <span style={{ color: 'var(--text-4)', fontSize: 10 }}>{d.leds} LEDs</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="MIDI">
            <Row label="Status">
              <Dot color={midi.enabled ? 'oklch(74% 0.13 210)' : '#555'}/>
              <span style={{ fontSize: 12 }}>{midi.enabled ? `${midi.devices.length} device(s)` : 'Disabled'}</span>
              {midi.error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>{midi.error}</span>}
              <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={midi.toggle}>
                {midi.enabled ? 'Disable' : 'Enable MIDI'}
              </button>
            </Row>
            {midi.enabled && midi.devices.map(d => (
              <Row key={d.id} label={d.name || 'Unknown'}>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{d.manufacturer}</span>
                <Dot color="oklch(72% 0.18 155)"/>
                <span style={{ fontSize: 11, color: 'oklch(72% 0.18 155)' }}>active</span>
              </Row>
            ))}
            {midi.enabled && midi.devices.length === 0 && (
              <div style={{ padding: '8px 0', fontSize: 11, color: 'var(--text-3)' }}>
                No MIDI devices found. Connect a device and refresh.
              </div>
            )}
            {midi.enabled && (
              <div style={{ padding: '8px 0', fontSize: 10, color: 'var(--text-4)' }}>
                CC 1 → master speed · CC 7 → master brightness · CC 11 → master saturation
              </div>
            )}
          </Section>

          <Section title="Visitor Page">
            <div style={{ padding: '6px 0', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.6 }}>
              The visitor page lets gallery guests control scenes from their phone.
              Share this URL with guests on the local network.
            </div>
            <Row label="Local URL">
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 11, flex: 1, color: 'var(--accent)', wordBreak: 'break-all' }}>
                {window.location.origin}/src/visitor/visitor.html
              </span>
            </Row>
            <Row label="Actions">
              <button className="btn btn-ghost" style={{ fontSize: 10 }}
                      onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/src/visitor/visitor.html`)}>
                Copy URL
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 10 }}
                      onClick={() => window.open(`${window.location.origin}/src/visitor/visitor.html`, '_blank')}>
                Open ↗
              </button>
            </Row>
            <div style={{ padding: '6px 0', fontSize: 10, color: 'var(--text-4)', lineHeight: 1.5 }}>
              In production, the visitor page is served at <code style={{ fontFamily: 'var(--mono-font)' }}>/visitor/</code> on the Pi.
              Configure PRESET_MAP in visitor.html to match your WLED preset numbers.
            </div>
          </Section>

          <Section title="WLED Segments">
            <div style={{ padding: '4px 0 8px', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
              Map layout strips to WLED segment numbers. WLED uses segments to address independent LED groups.
            </div>
            {strips.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-4)', padding: '4px 0' }}>
                No strips defined — add strips in Layout screen.
              </div>
            )}
            {strips.map((strip, i) => (
              <Row key={strip.id} label={strip.name || strip.id}>
                <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 60 }}>{strip.pixels?.length || 0} LEDs</span>
                <span style={{ fontSize: 11, color: 'var(--text-4)' }}>→ seg</span>
                <input
                  type="number" min="0" max="31" step="1"
                  value={segMap[strip.id] ?? i}
                  className="lw-search-input"
                  style={{ width: 48, textAlign: 'center' }}
                  onChange={e => {
                    const next = { ...segMap, [strip.id]: +e.target.value };
                    setSegMap(next);
                    try { localStorage.setItem(LS_SEGS_KEY, JSON.stringify(next)); } catch {}
                  }}
                />
              </Row>
            ))}
            {strips.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn btn-ghost"
                  disabled={!wledConnected}
                  title={wledConnected ? 'Push segment config to WLED' : 'Connect to WLED first'}
                  onClick={async () => {
                    setPushStatus('Pushing…');
                    const segs = strips.map((strip, i) => ({
                      id: segMap[strip.id] ?? i,
                      start: 0,
                      stop: strip.pixels?.length || 30,
                      on: true,
                    }));
                    try {
                      const r = await fetch(`http://${wledIp}/json/state`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ seg: segs }),
                        signal: AbortSignal.timeout(3000),
                      });
                      setPushStatus(r.ok ? '✓ Pushed' : `Error ${r.status}`);
                    } catch (err) {
                      setPushStatus(`Error: ${err.message}`);
                    }
                    setTimeout(() => setPushStatus(''), 3000);
                  }}>
                  Push to WLED
                </button>
                {pushStatus && <span style={{ fontSize: 11, color: 'var(--accent)' }}>{pushStatus}</span>}
              </div>
            )}
          </Section>

          <Section title="Audio">
            <Row label="Microphone">
              <span style={{ fontSize: 12 }}>Enable via Audio toggle in toolbar</span>
            </Row>
            <div style={{ padding: '6px 0', fontSize: 10, color: 'var(--text-4)' }}>
              Audio analysis feeds bass/mid/hi bands into pattern engine in real-time.
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
