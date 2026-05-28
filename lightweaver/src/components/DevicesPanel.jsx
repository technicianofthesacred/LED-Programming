import { useState, useEffect, useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { useMidi } from '../hooks/useMidi.js';
import { makeWledSegments, postWledState } from '../lib/deviceController.js';
import { auditWledControllerCompatibility } from '../lib/controllerCompatibility.js';
import { makeSafeWledTestState, pickBestWledDevice, sortWledDevices } from '../lib/wledDiscovery.js';
import { buildWledBasicPackage } from '../lib/wledBasicExport.js';
import { buildWledInstallWizardPlan } from '../lib/wledInstallWizard.js';
import { makeCardRuntimePackage } from '../lib/cardRuntimeContract.js';
import {
  normalizeWledPhysicalControls,
} from '../lib/wledControlContract.js';
import {
  buildControllerProfile,
  controllerProfileReadiness,
  estimatePowerBudget,
  makeArtNetNotes,
  makeDhcpReservationNote,
  makeEveryNthMarkerState,
  makeInstallReadinessReport,
  makeKnownGoodRecoveryState,
  makePixelCountProbeState,
  makePixelMarkerState,
  makeSnapshotFilename,
  makeWledHostname,
  mergeControllerProfile,
} from '../lib/controllerProfiles.js';

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
      <span style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)', minWidth: 90 }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
      {hint && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{hint}</span>}
    </div>
  );
}

function Dot({ color }) {
  return <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }}/>;
}

function totalStripPixels(strips = []) {
  return strips.reduce((sum, strip) => sum + (strip.pixels?.length || strip.pixelCount || 0), 0);
}

async function fetchWledResource(ip, path, fallback = null) {
  if (!ip) return fallback;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const r = await fetch(`http://${ip}${path}`, { signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch {
    try {
      const proxy = await fetch(`/api/wled/raw?ip=${encodeURIComponent(ip)}&path=${encodeURIComponent(path)}`);
      if (!proxy.ok) return fallback;
      return await proxy.json();
    } catch {
      return fallback;
    }
  } finally {
    clearTimeout(timer);
  }
}

export function DevicesPanel({ onClose }) {
  const {
    wledIp, setWledIp, wledConnected, wledTransport, wledConnect, wledDisconnect,
    wledGetInfo, strips,
    wledSegmentMap, setWledSegmentMap,
    controllerProfiles, setControllerProfiles,
    activeControllerId, setActiveControllerId,
    physicalControls,
    projectName, activePatternId, showClips, palette,
    standaloneController,
  } = useProject();
  const [cardLoadStatus, setCardLoadStatus] = useState('');
  const [cardConfigJson, setCardConfigJson] = useState('');
  const [scanResults, setScanResults] = useState([]);
  const [scanning,    setScanning]    = useState(false);
  const [pingMs,      setPingMs]      = useState(null);
  const [pushStatus, setPushStatus] = useState('');
  const [discoverStatus, setDiscoverStatus] = useState('');
  const [profileStatus, setProfileStatus] = useState('');

  const [wledInfo, setWledInfo] = useState(null);
  const [installAudit, setInstallAudit] = useState(null);
  const [installAuditStatus, setInstallAuditStatus] = useState('');
  const [pixelProbeIndex, setPixelProbeIndex] = useState(0);
  const activeProfile = useMemo(
    () => controllerProfiles.find(profile => profile.id === activeControllerId) || controllerProfiles[0] || null,
    [activeControllerId, controllerProfiles],
  );
  const activePhysicalControls = useMemo(
    () => normalizeWledPhysicalControls(physicalControls || activeProfile?.physicalControls),
    [physicalControls, activeProfile?.physicalControls],
  );
  const activePixelCount = Math.max(1, Number(activeProfile?.led?.length || wledInfo?.leds?.count || 40));
  const readiness = useMemo(() => activeProfile ? controllerProfileReadiness(activeProfile) : null, [activeProfile]);
  const powerBudget = useMemo(() => activeProfile ? estimatePowerBudget(activeProfile) : null, [activeProfile]);
  const installReport = useMemo(
    () => activeProfile ? makeInstallReadinessReport(activeProfile, { snapshotSaved: !!activeProfile.backup?.lastSnapshotAt }) : '',
    [activeProfile],
  );
  const wledBasicPackage = useMemo(() => buildWledBasicPackage({
    projectName,
    activePatternId,
    showClips,
    strips,
    palette,
    maxSegments: wledInfo?.leds?.maxseg || 16,
    physicalControls: activePhysicalControls,
  }), [projectName, activePatternId, showClips, strips, palette, wledInfo, activePhysicalControls]);
  const installWizardPlan = useMemo(() => buildWledInstallWizardPlan({
    controllerAudit: installAudit,
    wledPackage: wledBasicPackage,
    backupSaved: Boolean(activeProfile?.backup?.lastSnapshotAt),
  }), [installAudit, wledBasicPackage, activeProfile]);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    setPixelProbeIndex(index => Math.max(0, Math.min(activePixelCount - 1, index)));
  }, [activePixelCount]);

  const midi = useMidi({
    onCC: (ch, cc, val) => console.debug('[MIDI CC]', ch, cc, val),
  });

  // Fetch WLED device info
  const fetchWledInfo = async () => {
    if (!wledIp) return;
    try {
      setWledInfo(await wledGetInfo());
    } catch {}
  };

  useEffect(() => {
    if (wledConnected && wledIp) fetchWledInfo();
    else setWledInfo(null);
  }, [wledConnected, wledIp, wledGetInfo]);

  const sendTestPattern = async (color = 'blue') => {
    if (!wledIp) return;
    try {
      await postWledState(wledIp, makeSafeWledTestState(color));
      setPushStatus(`Sent ${color} test`);
    } catch (e) {
      setPushStatus(`Test failed: ${e.message}`);
      console.warn('Test pattern failed:', e);
    }
    setTimeout(() => setPushStatus(''), 3000);
  };

  // Ping WLED device when connected
  useEffect(() => {
    if (!wledConnected || !wledIp) { setPingMs(null); return; }
    let cancelled = false;
    const doPing = async () => {
      const t0 = performance.now();
      try {
        await wledGetInfo();
        if (!cancelled) setPingMs(Math.round(performance.now() - t0));
      } catch { if (!cancelled) setPingMs(null); }
    };
    doPing();
    const iv = setInterval(doPing, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [wledConnected, wledIp, wledGetInfo]);

  // Subnet scan — tries common WLED IPs on the local /24 via HTTP
  const discoverDevices = async ({ scan = false, quiet = false } = {}) => {
    setScanning(true);
    if (!quiet) setScanResults([]);
    if (!quiet) setDiscoverStatus(scan ? 'Scanning LAN...' : 'Looking for WLED...');
    try {
      const params = new URLSearchParams();
      if (wledIp) params.set('ip', wledIp);
      if (scan) params.set('scan', '1');
      const r = await fetch(`/api/wled/discover?${params.toString()}`, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const data = await r.json();
        const devices = sortWledDevices(data.devices || [], wledIp);
        setScanResults(devices);
        setScanning(false);
        setDiscoverStatus(devices.length ? `${devices.length} WLED device${devices.length === 1 ? '' : 's'} found` : 'No WLED devices found');
        return devices;
      }
    } catch {
      // Dev fallback below handles direct browser-to-WLED probing when the Pi API is absent.
    }

    if (!scan) {
      setScanning(false);
      setDiscoverStatus(quiet ? '' : 'No Pi discovery service available');
      return [];
    }

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
    const devices = sortWledDevices(found, wledIp);
    setScanResults(devices);
    setScanning(false);
    setDiscoverStatus(devices.length ? `${devices.length} WLED device${devices.length === 1 ? '' : 's'} found` : 'No WLED devices found');
    return devices;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (wledConnected || scanResults.length > 0) return;
      const devices = await discoverDevices({ scan: false, quiet: true });
      if (!cancelled && devices?.length) setDiscoverStatus('WLED detected');
    })();
    return () => { cancelled = true; };
  }, []);

  const handleScan = async () => {
    await discoverDevices({ scan: true });
  };

  const connectToDevice = (device) => {
    if (!device?.ip) return;
    setWledIp(device.ip);
    wledConnect(device.ip);
    setDiscoverStatus(`Connecting to ${device.name || 'WLED'} at ${device.ip}`);
  };

  const upsertProfile = (nextProfile) => {
    setControllerProfiles(prev => {
      const index = prev.findIndex(profile => profile.id === nextProfile.id);
      if (index === -1) return [...prev, nextProfile];
      return prev.map(profile => profile.id === nextProfile.id ? nextProfile : profile);
    });
    setActiveControllerId(nextProfile.id);
    if (nextProfile.ip) setWledIp(nextProfile.ip);
  };

  const saveProfileFromWled = async () => {
    try {
      const info = wledInfo || await wledGetInfo();
      const existing = activeProfile && (activeProfile.mac === info.mac || activeProfile.ip === (info.ip || wledIp)) ? activeProfile : {};
      const nextProfile = mergeControllerProfile(existing, info, { ip: info.ip || wledIp });
      upsertProfile(nextProfile);
      setWledInfo(info);
      setProfileStatus(`Saved profile ${nextProfile.id}`);
    } catch (error) {
      setProfileStatus(`Profile save failed: ${error.message}`);
    }
    setTimeout(() => setProfileStatus(''), 4000);
  };

  const updateActiveProfile = (updater) => {
    if (!activeProfile) return;
    setControllerProfiles(prev => prev.map(profile => {
      if (profile.id !== activeProfile.id) return profile;
      const next = typeof updater === 'function' ? updater(profile) : { ...profile, ...updater };
      return { ...next, hostname: next.hostname || makeWledHostname(next) };
    }));
  };

  const sendState = async (state, label) => {
    if (!wledIp) return;
    try {
      await postWledState(wledIp, state);
      setProfileStatus(label);
      if (activeProfile) {
        updateActiveProfile(profile => ({
          ...profile,
          calibration: { ...(profile.calibration || {}), lastTest: label },
        }));
      }
    } catch (error) {
      setProfileStatus(`${label} failed: ${error.message}`);
    }
    setTimeout(() => setProfileStatus(''), 3000);
  };

  const updatePixelCount = async (pixelCount, { sendEndpoint = false } = {}) => {
    if (!activeProfile) return;
    const nextCount = Math.max(1, Math.min(4096, Math.round(Number(pixelCount) || activePixelCount)));
    const nextIndex = Math.max(0, Math.min(nextCount - 1, sendEndpoint ? nextCount - 1 : pixelProbeIndex));
    updateActiveProfile(profile => ({
      ...profile,
      led: { ...profile.led, length: nextCount },
      calibration: { ...profile.calibration, pixelCountConfirmed: false },
    }));
    setPixelProbeIndex(nextIndex);
    if (sendEndpoint) {
      const probe = makePixelCountProbeState(nextCount, nextIndex);
      await sendState(probe.state, `Endpoint marker ${probe.markerIndex + 1}/${probe.pixelCount}`);
    }
  };

  const sendPixelProbe = async (markerIndex = pixelProbeIndex, pixelCount = activePixelCount) => {
    const probe = makePixelCountProbeState(pixelCount, markerIndex);
    setPixelProbeIndex(probe.markerIndex);
    await sendState(probe.state, `Marker ${probe.markerIndex + 1}/${probe.pixelCount}`);
  };

  const captureSnapshot = async () => {
    if (!wledIp || !activeProfile) return;
    try {
      const r = await fetch(`/api/wled/snapshot?ip=${encodeURIComponent(wledIp)}`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snapshot = await r.json();
      const savedAt = new Date().toISOString();
      updateActiveProfile(profile => ({
        ...profile,
        backup: { ...(profile.backup || {}), lastSnapshotAt: savedAt, snapshot },
      }));
      setProfileStatus(`Snapshot saved as ${makeSnapshotFilename(activeProfile)}`);
    } catch (error) {
      setProfileStatus(`Snapshot failed: ${error.message}`);
    }
    setTimeout(() => setProfileStatus(''), 4000);
  };

  const runInstallAudit = async () => {
    if (!wledIp) {
      setInstallAuditStatus('Set a WLED IP first');
      setTimeout(() => setInstallAuditStatus(''), 3500);
      return;
    }
    setInstallAuditStatus('Auditing controller...');
    try {
      const [directInfo, state, cfg, presets, ledMap] = await Promise.all([
        fetchWledResource(wledIp, '/json/info', null),
        fetchWledResource(wledIp, '/json/state', {}),
        fetchWledResource(wledIp, '/cfg.json', {}),
        fetchWledResource(wledIp, '/presets.json', {}),
        fetchWledResource(wledIp, '/ledmap.json', null),
      ]);
      const info = directInfo || wledInfo || await wledGetInfo();
      const expectedPixels = totalStripPixels(strips) || activeProfile?.led?.length || info?.leds?.count || 0;
      const audit = auditWledControllerCompatibility({
        info,
        state,
        cfg,
        presets,
        ledMap,
        expected: {
          pixelCount: expectedPixels,
          segmentCount: Math.max(1, strips.filter(strip => (strip.pixels?.length || strip.pixelCount || 0) > 0).length || 1),
          requiresLedMap: false,
          requiresArtNet: false,
          usesAudioPatterns: false,
        },
      });
      setWledInfo(info);
      setInstallAudit(audit);
      setInstallAuditStatus(`Audit ${audit.summary.status}`);
    } catch (error) {
      setInstallAuditStatus(`Audit failed: ${error.message}`);
    }
    setTimeout(() => setInstallAuditStatus(''), 4500);
  };

  const recoverKnownGood = async () => {
    if (!wledIp) return;
    try {
      const r = await fetch(`/api/wled/recover?ip=${encodeURIComponent(wledIp)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProfileStatus('Known-good state restored');
    } catch {
      await sendState(makeKnownGoodRecoveryState(), 'Known-good state restored');
      return;
    }
    setTimeout(() => setProfileStatus(''), 3000);
  };

  const restoreSnapshotState = async () => {
    if (!wledIp || !activeProfile?.backup?.snapshot?.state) {
      setProfileStatus('No snapshot state saved');
      setTimeout(() => setProfileStatus(''), 3000);
      return;
    }
    await sendState(activeProfile.backup.snapshot.state, 'Snapshot state restored');
  };

  const buildCardConfigPayload = () => {
    const outputs = (standaloneController?.outputs || []).map((o, i) => ({
      id: o.id || `out${i + 1}`,
      name: o.name || `Output ${i + 1}`,
      pin: o.pin,
      pixels: o.pixels,
    }));
    const cardLed = {
      pixels: totalStripPixels(strips) || outputs.reduce((s, o) => s + (o.pixels || 0), 0) || undefined,
      colorOrder: standaloneController?.led?.colorOrder,
      brightnessLimit: standaloneController?.led?.brightnessLimit,
      outputs: outputs.length ? outputs : undefined,
    };
    return makeCardRuntimePackage({
      projectName,
      mode: 'website-flash',
      led: cardLed,
      controls: standaloneController?.controls,
    });
  };

  const loadToCard = async () => {
    const payload = buildCardConfigPayload();
    const body = JSON.stringify(payload.config);
    setCardLoadStatus('Sending to card...');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch('http://192.168.4.1/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCardLoadStatus('Saved on card');
      setCardConfigJson('');
    } catch (err) {
      setCardLoadStatus('Direct POST blocked. Copy the JSON below, connect to Lightweaver-XXXX, open http://192.168.4.1, paste, and press Save to card.');
      setCardConfigJson(JSON.stringify(payload.config, null, 2));
    }
    setTimeout(() => setCardLoadStatus(s => s.startsWith('Saved') ? '' : s), 8000);
  };

  const handlePrimaryConnect = async () => {
    if (wledConnected) {
      wledDisconnect();
      return;
    }
    if (wledIp.trim()) {
      wledConnect();
      return;
    }
    const devices = scanResults.length ? scanResults : await discoverDevices({ scan: false });
    const best = pickBestWledDevice(devices);
    if (best) connectToDevice(best);
    else setDiscoverStatus('No WLED IP set and no device was discovered');
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
              <span style={{ fontSize: 'var(--fs-md)' }}>{wledConnected ? 'Connected' : 'Disconnected'}</span>
              {wledConnected && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', fontFamily: 'var(--mono-font)' }}>{wledTransport}</span>}
              {wledConnected && pingMs !== null && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>{pingMs} ms</span>}
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
              <button className="btn" onClick={handlePrimaryConnect} disabled={scanning}>
                {wledConnected ? 'Disconnect' : scanning ? 'Finding...' : wledIp.trim() ? 'Connect' : 'Find & Connect'}
              </button>
            </Row>
            <Row label="Network scan">
              <button className="btn btn-ghost" onClick={handleScan} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Scan LAN'}
              </button>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
                {discoverStatus || 'uses Pi discovery, falls back in dev'}
              </span>
            </Row>
            {!wledConnected && scanResults.length > 0 && (
              <Row label="Best match">
                {(() => {
                  const best = pickBestWledDevice(scanResults, wledIp);
                  if (!best) return null;
                  return (
                    <>
                      <span style={{ fontSize: 'var(--fs-sm)', fontFamily: 'var(--mono-font)' }}>{best.ip}</span>
                      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{best.ver ? `v${best.ver}` : best.source}</span>
                      <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => connectToDevice(best)}>
                        Use this
                      </button>
                    </>
                  );
                })()}
              </Row>
            )}
            {wledConnected && (
              <Row label="Test pattern">
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => sendTestPattern('blue')}>
                  Blue
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }} onClick={() => sendTestPattern('amber')}>
                  Amber
                </button>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>Low-brightness solid output for bench testing</span>
              </Row>
            )}
            {wledInfo && (
              <Row label="Device info">
                <span style={{ fontSize: 'var(--fs-sm)', fontFamily: 'var(--mono-font)' }}>{wledInfo.name}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>v{wledInfo.ver}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{wledInfo.leds?.count} LEDs · {wledInfo.leds?.fps} fps</span>
              </Row>
            )}
            {wledInfo && (
              <Row label="Health">
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)', fontFamily: 'var(--mono-font)' }}>
                  {wledInfo.ip || wledIp}
                </span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
                  MAC {wledInfo.mac || 'unknown'}
                </span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
                  heap {wledInfo.freeheap ? `${Math.round(wledInfo.freeheap / 1024)} kB` : 'n/a'}
                </span>
                {wledInfo.wifi?.signal != null && (
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
                    WiFi {wledInfo.wifi.signal}%
                  </span>
                )}
              </Row>
            )}
            {scanResults.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {scanResults.map(d => (
                  <div key={d.ip}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0',
                             fontSize: 'var(--fs-md)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => connectToDevice(d)}
                  >
                    <Dot color="oklch(74% 0.13 210)"/>
                    <span style={{ flex: 1 }}>{d.name}</span>
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono-font)' }}>{d.ip}</span>
                    {d.ver && <span style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>v{d.ver}</span>}
                    {d.leds && <span style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>{d.leds} LEDs</span>}
                    {d.signal != null && <span style={{ color: 'var(--text-4)', fontSize: 'var(--fs-xs)' }}>{d.signal}%</span>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="Controller Profile">
            <Row label="Profile">
              <button className="btn btn-primary" onClick={saveProfileFromWled} disabled={!wledIp && !wledConnected}>
                Save from WLED
              </button>
              {controllerProfiles.length > 0 && (
                <select
                  className="lw-search-input"
                  style={{ flex: 1 }}
                  value={activeProfile?.id || ''}
                  onChange={e => setActiveControllerId(e.target.value)}
                >
                  {controllerProfiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.name} ({profile.ip || profile.id})</option>
                  ))}
                </select>
              )}
              {profileStatus && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)' }}>{profileStatus}</span>}
            </Row>
            {!activeProfile && (
              <div style={{ padding: '6px 0', fontSize: 'var(--fs-sm)', color: 'var(--text-4)' }}>
                Connect to WLED, then save a profile to unlock calibration, backup, Art-Net notes, and readiness reporting.
              </div>
            )}
            {activeProfile && (
              <>
                <Row label="Identity">
                  <input className="lw-search-input" style={{ flex: 1 }} value={activeProfile.name}
                    onChange={e => updateActiveProfile(profile => ({ ...profile, name: e.target.value }))}/>
                  <input className="lw-search-input" style={{ width: 92 }} value={activeProfile.role}
                    onChange={e => updateActiveProfile(profile => ({ ...profile, role: e.target.value }))}/>
                </Row>
                <Row label="Network">
                  <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--mono-font)', color: 'var(--text-3)' }}>{activeProfile.ip || 'no IP'}</span>
                  <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--mono-font)', color: 'var(--text-4)' }}>{activeProfile.hostname}</span>
                </Row>
                <Row label="DHCP">
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>{makeDhcpReservationNote(activeProfile)}</span>
                  <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                    onClick={() => navigator.clipboard?.writeText(makeDhcpReservationNote(activeProfile))}>
                    Copy
                  </button>
                </Row>
                <Row label="Firmware">
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>v{activeProfile.version || 'unknown'}</span>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{activeProfile.release || activeProfile.arch}</span>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{activeProfile.flashMb || '?'}MB flash</span>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{activeProfile.psramBytes ? `${Math.round(activeProfile.psramBytes / 1024 / 1024)}MB PSRAM` : 'PSRAM n/a'}</span>
                </Row>
              </>
            )}
          </Section>

          {activeProfile && (
            <Section title="First-Run Setup">
              {[
                ['Find controller', !!activeProfile.ip],
                ['Verify firmware', !!activeProfile.version],
                ['Set LED basics', !!(activeProfile.led?.length && activeProfile.led?.dataPin >= 0 && activeProfile.led?.colorOrder)],
                ['Confirm color order', !!activeProfile.calibration?.colorOrderConfirmed],
                ['Confirm pixel count/direction', !!activeProfile.calibration?.pixelCountConfirmed],
                ['Save WLED snapshot', !!activeProfile.backup?.lastSnapshotAt],
              ].map(([label, ok]) => (
                <Row key={label} label={label}>
                  <Dot color={ok ? 'oklch(72% 0.18 155)' : 'oklch(64% 0.20 25)'}/>
                  <span style={{ fontSize: 'var(--fs-sm)', color: ok ? 'var(--text-2)' : 'var(--text-4)' }}>{ok ? 'done' : 'open'}</span>
                </Row>
              ))}
            </Section>
          )}

          {activeProfile && (
            <Section title="LED Basics">
              <Row label="Strip">
                <select className="lw-search-input" style={{ width: 110 }} value={activeProfile.led?.type || 'WS2815'}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, led: { ...profile.led, type: e.target.value } }))}>
                  {['WS2815', 'WS2812B', 'SK6812', 'APA102', 'Other'].map(type => <option key={type}>{type}</option>)}
                </select>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>pixels</span>
                <input type="number" min="1" className="lw-search-input" style={{ width: 74 }} value={activeProfile.led?.length || 0}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, led: { ...profile.led, length: Number(e.target.value) || 0 } }))}/>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>GPIO</span>
                <input type="number" min="0" className="lw-search-input" style={{ width: 54 }} value={activeProfile.led?.dataPin ?? 16}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, led: { ...profile.led, dataPin: Number(e.target.value) || 0 }, wiring: { ...profile.wiring, dataGpio: Number(e.target.value) || 0 } }))}/>
              </Row>
              <Row label="Color">
                <select className="lw-search-input" style={{ width: 90 }} value={activeProfile.led?.colorOrder || 'GRB'}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, led: { ...profile.led, colorOrder: e.target.value }, calibration: { ...profile.calibration, colorOrderConfirmed: false } }))}>
                  {['GRB', 'RGB', 'BRG', 'BGR', 'RBG', 'GBR'].map(order => <option key={order}>{order}</option>)}
                </select>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>max brightness</span>
                <input type="number" min="1" max="255" className="lw-search-input" style={{ width: 64 }} value={activeProfile.led?.maxBrightness ?? 180}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, led: { ...profile.led, maxBrightness: Number(e.target.value) || 180 } }))}/>
              </Row>
            </Section>
          )}

          {activeProfile && (
            <Section title="Calibration">
              <Row label="Color test">
                {['red', 'green', 'blue', 'white'].map(color => (
                  <button key={color} className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                    onClick={() => sendState(makeSafeWledTestState(color), `Sent ${color} color test`)}>
                    {color}
                  </button>
                ))}
                <button className="btn btn-primary" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => updateActiveProfile(profile => ({ ...profile, calibration: { ...profile.calibration, colorOrderConfirmed: true } }))}>
                  Confirm color
                </button>
              </Row>
              <Row label="Pixel test">
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => sendState(makePixelMarkerState(activeProfile.led?.length || 30, 0), 'Lit first pixel')}>
                  First
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => sendState(makePixelMarkerState(activeProfile.led?.length || 30, (activeProfile.led?.length || 30) - 1), 'Lit last pixel')}>
                  Last
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => sendState(makeEveryNthMarkerState(activeProfile.led?.length || 30, 10), 'Lit every tenth pixel')}>
                  Every 10
                </button>
                <button className="btn btn-primary" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => updateActiveProfile(profile => ({ ...profile, calibration: { ...profile.calibration, pixelCountConfirmed: true } }))}>
                  Confirm pixels
                </button>
                <select className="lw-search-input" style={{ width: 96 }} value={activeProfile.calibration?.direction || 'forward'}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, calibration: { ...profile.calibration, direction: e.target.value, pixelCountConfirmed: false } }))}>
                  <option value="forward">forward</option>
                  <option value="reverse">reverse</option>
                </select>
              </Row>
              <Row label="Count probe" hint="WLED LED Preferences must be at least this count">
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => updatePixelCount(activePixelCount - 1, { sendEndpoint: true })}>
                  -1
                </button>
                <input type="number" min="1" max="4096" className="lw-search-input" style={{ width: 68 }}
                  value={activePixelCount}
                  onChange={e => updatePixelCount(e.target.value)}/>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => updatePixelCount(activePixelCount + 1, { sendEndpoint: true })}>
                  +1
                </button>
                <input type="range" min="0" max={Math.max(0, activePixelCount - 1)} step="1"
                  value={Math.max(0, Math.min(activePixelCount - 1, pixelProbeIndex))}
                  onChange={e => sendPixelProbe(Number(e.target.value), activePixelCount)}
                  style={{ flex: 1, minWidth: 90 }}/>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)', fontFamily: 'var(--mono-font)', minWidth: 54 }}>
                  {Math.max(0, Math.min(activePixelCount - 1, pixelProbeIndex)) + 1}/{activePixelCount}
                </span>
                <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => sendPixelProbe(activePixelCount - 1, activePixelCount)}>
                  End
                </button>
                <button className="btn btn-primary" style={{ fontSize: 'var(--fs-xs)' }}
                  onClick={() => updateActiveProfile(profile => ({ ...profile, calibration: { ...profile.calibration, pixelCountConfirmed: true } }))}>
                  Lock count
                </button>
              </Row>
            </Section>
          )}

          {activeProfile && (
            <Section title="Power Safety">
              <Row label="Supply">
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>volts</span>
                <input type="number" className="lw-search-input" style={{ width: 58 }} value={activeProfile.power?.voltage || 12}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, power: { ...profile.power, voltage: Number(e.target.value) || 12 } }))}/>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>amps</span>
                <input type="number" className="lw-search-input" style={{ width: 58 }} value={activeProfile.power?.psuAmps || 5}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, power: { ...profile.power, psuAmps: Number(e.target.value) || 0 } }))}/>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>mA/px</span>
                <input type="number" className="lw-search-input" style={{ width: 58 }} value={activeProfile.power?.milliampsPerPixel || 12}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, power: { ...profile.power, milliampsPerPixel: Number(e.target.value) || 12 } }))}/>
              </Row>
              <Row label="Estimate">
                <Dot color={powerBudget?.status === 'ok' ? 'oklch(72% 0.18 155)' : 'oklch(64% 0.20 25)'}/>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>{powerBudget?.maxAmps}A max at cap</span>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-4)' }}>{powerBudget?.headroomAmps}A headroom</span>
              </Row>
              <Row label="Wiring">
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
                  <input type="checkbox" checked={!!activeProfile.power?.commonGround}
                    onChange={e => updateActiveProfile(profile => ({ ...profile, power: { ...profile.power, commonGround: e.target.checked } }))}/>
                  common ground
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
                  <input type="checkbox" checked={!!activeProfile.power?.levelShifter}
                    onChange={e => updateActiveProfile(profile => ({ ...profile, power: { ...profile.power, levelShifter: e.target.checked } }))}/>
                  level shifter
                </label>
              </Row>
              <Row label="Notes">
                <input className="lw-search-input" style={{ flex: 1 }} value={activeProfile.wiring?.notes || ''}
                  placeholder="Injection points, fuse, cable run, enclosure notes"
                  onChange={e => updateActiveProfile(profile => ({ ...profile, wiring: { ...profile.wiring, notes: e.target.value } }))}/>
              </Row>
            </Section>
          )}

          {activeProfile && (
            <Section title="Backup & Recovery">
              <Row label="Snapshot">
                <button className="btn btn-ghost" onClick={captureSnapshot} disabled={!wledIp}>Save WLED snapshot</button>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
                  {activeProfile.backup?.lastSnapshotAt ? new Date(activeProfile.backup.lastSnapshotAt).toLocaleString() : 'not saved'}
                </span>
              </Row>
              <Row label="Recovery">
                <button className="btn btn-ghost" onClick={recoverKnownGood} disabled={!wledIp}>Known-good state</button>
                <button className="btn btn-ghost" onClick={restoreSnapshotState} disabled={!wledIp || !activeProfile.backup?.snapshot?.state}>Restore snapshot state</button>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>low brightness solid amber</span>
              </Row>
            </Section>
          )}

          <Section title="Lightweaver Card">
            <p className="small" style={{ margin: '4px 0 8px', fontSize: 'var(--fs-sm)', color: 'var(--text-3)', lineHeight: 1.5 }}>
              Connect to the card WiFi, then save this pattern order to ESP32 internal flash. The card keeps running after the website closes.
            </p>
            <Row label="Install">
              <button className="btn primary btn-primary" onClick={loadToCard}>Load to Card</button>
              <button className="btn" disabled title="Memory card preparation is exported from the Export dialog (Lightweaver Card · microSD package)">Prepare Memory Card</button>
              {cardLoadStatus && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)' }}>{cardLoadStatus}</span>}
            </Row>
            {cardConfigJson && (
              <Row label="JSON">
                <textarea readOnly value={cardConfigJson}
                  className="lw-search-input"
                  style={{ width: '100%', minHeight: 140, resize: 'vertical', fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', lineHeight: 1.4 }}/>
              </Row>
            )}
          </Section>

          <Section title="WLED Basic Installer">
            <div className="lw-install-wizard">
              <div className="lw-install-wizard-head">
                <div>
                  <div className="eyebrow">Package</div>
                  <div className="title">{installWizardPlan.packageSummary.presets} presets · playlist {installWizardPlan.packageSummary.playlistPresetId || 'open'}</div>
                </div>
                <span className={`lw-install-status is-${installWizardPlan.status}`}>
                  {installWizardPlan.status}
                </span>
              </div>
              <div className="lw-install-grid">
                <span>{installWizardPlan.packageSummary.customEffectPorts} ports</span>
                <span>{installWizardPlan.packageSummary.unsupportedPatterns} gated</span>
                <span>{installWizardPlan.packageSummary.ledCount || activeProfile?.led?.length || 0} px</span>
              </div>
              <div className="lw-install-steps">
                {installWizardPlan.steps.map(step => (
                  <div key={step.id} className={`lw-install-step is-${step.state}`}>
                    <Dot color={step.state === 'ready' ? 'oklch(72% 0.18 155)' : step.state === 'blocked' ? 'oklch(64% 0.20 25)' : 'oklch(78% 0.11 80)'}/>
                    <div>
                      <span>{step.label}</span>
                      <small>{step.detail}</small>
                    </div>
                  </div>
                ))}
              </div>
              <Row label="Next">
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>{wledIp ? installWizardPlan.nextAction.label : 'Set WLED IP'}</span>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>{wledIp ? installWizardPlan.nextAction.detail : 'Enter or discover the controller before audit.'}</span>
              </Row>
              <Row label="Actions">
                <button className="btn btn-primary" onClick={runInstallAudit} disabled={!wledIp}>
                  Run audit
                </button>
                <button className="btn btn-ghost" disabled={!installWizardPlan.canInstall} title="Direct install stays disabled until backup and geometry checks pass">
                  Apply package
                </button>
                {installAuditStatus && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)' }}>{installAuditStatus}</span>}
              </Row>
            </div>
          </Section>

          {activeProfile && (
            <Section title="Madrix / Art-Net">
              <Row label="Art-Net">
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
                  <input type="checkbox" checked={!!activeProfile.artnet?.enabled}
                    onChange={e => updateActiveProfile(profile => ({ ...profile, artnet: { ...profile.artnet, enabled: e.target.checked } }))}/>
                  enabled in WLED
                </label>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>universe</span>
                <input type="number" className="lw-search-input" style={{ width: 56 }} value={activeProfile.artnet?.startUniverse ?? 0}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, artnet: { ...profile.artnet, startUniverse: Number(e.target.value) || 0 } }))}/>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>fps</span>
                <input type="number" className="lw-search-input" style={{ width: 56 }} value={activeProfile.artnet?.fps ?? 40}
                  onChange={e => updateActiveProfile(profile => ({ ...profile, artnet: { ...profile.artnet, fps: Number(e.target.value) || 40 } }))}/>
              </Row>
              <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', color: 'var(--text-3)', background: 'var(--surface)', border: '1px solid var(--border)', padding: 8, borderRadius: 4 }}>
                {makeArtNetNotes(activeProfile)}
              </pre>
            </Section>
          )}

          {activeProfile && (
            <Section title="Install Report">
              <Row label="Readiness">
                <Dot color={readiness?.ready ? 'oklch(72% 0.18 155)' : 'oklch(64% 0.20 25)'}/>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>{readiness?.ready ? 'ready' : 'open checks remain'}</span>
                <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)' }}
                  onClick={() => navigator.clipboard?.writeText(installReport)}>
                  Copy report
                </button>
              </Row>
              <textarea className="lw-search-input" readOnly value={installReport}
                style={{ width: '100%', minHeight: 190, resize: 'vertical', fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-xs)', lineHeight: 1.45 }}/>
            </Section>
          )}

          <Section title="MIDI">
            <Row label="Status">
              <Dot color={midi.enabled ? 'oklch(74% 0.13 210)' : '#555'}/>
              <span style={{ fontSize: 'var(--fs-md)' }}>{midi.enabled ? `${midi.devices.length} device(s)` : 'Disabled'}</span>
              {midi.error && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--danger)' }}>{midi.error}</span>}
              <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={midi.toggle}>
                {midi.enabled ? 'Disable' : 'Enable MIDI'}
              </button>
            </Row>
            {midi.enabled && midi.devices.map(d => (
              <Row key={d.id} label={d.name || 'Unknown'}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>{d.manufacturer}</span>
                <Dot color="oklch(72% 0.18 155)"/>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'oklch(72% 0.18 155)' }}>active</span>
              </Row>
            ))}
            {midi.enabled && midi.devices.length === 0 && (
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-sm)', color: 'var(--text-3)' }}>
                No MIDI devices found. Connect a device and refresh.
              </div>
            )}
            {midi.enabled && (
              <div style={{ padding: '8px 0', fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
                CC 1 → master speed · CC 7 → master brightness · CC 11 → master saturation
              </div>
            )}
          </Section>

          <Section title="Visitor Page">
            <div style={{ padding: '6px 0', fontSize: 'var(--fs-sm)', color: 'var(--text-3)', lineHeight: 1.6 }}>
              The visitor page lets gallery guests control scenes from their phone.
              Share this URL with guests on the local network.
            </div>
            <Row label="Local URL">
              <span style={{ fontFamily: 'var(--mono-font)', fontSize: 'var(--fs-sm)', flex: 1, color: 'var(--accent)', wordBreak: 'break-all' }}>
                {window.location.origin}/src/visitor/visitor.html
              </span>
            </Row>
            <Row label="Actions">
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                      onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/src/visitor/visitor.html`)}>
                Copy URL
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 'var(--fs-xs)' }}
                      onClick={() => window.open(`${window.location.origin}/src/visitor/visitor.html`, '_blank')}>
                Open ↗
              </button>
            </Row>
            <div style={{ padding: '6px 0', fontSize: 'var(--fs-xs)', color: 'var(--text-4)', lineHeight: 1.5 }}>
              In production, the visitor page is served at <code style={{ fontFamily: 'var(--mono-font)' }}>/visitor/</code> on the Pi.
              Configure PRESET_MAP in visitor.html to match your WLED preset numbers.
            </div>
          </Section>

          <Section title="WLED Segments">
            <div style={{ padding: '4px 0 8px', fontSize: 'var(--fs-sm)', color: 'var(--text-3)', lineHeight: 1.5 }}>
              Map layout strips to WLED segment numbers. WLED uses segments to address independent LED groups.
            </div>
            {strips.length === 0 && (
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-4)', padding: '4px 0' }}>
                No strips defined — add strips in Layout screen.
              </div>
            )}
            {strips.map((strip, i) => (
              <Row key={strip.id} label={strip.name || strip.id}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-3)', minWidth: 60 }}>{strip.pixels?.length || 0} LEDs</span>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-4)' }}>→ seg</span>
                <input
                  type="number" min="0" max="31" step="1"
                  value={wledSegmentMap[strip.id] ?? i}
                  className="lw-search-input"
                  style={{ width: 48, textAlign: 'center' }}
                  onChange={e => {
                    setWledSegmentMap({ ...wledSegmentMap, [strip.id]: +e.target.value });
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
                    try {
                      await postWledState(wledIp, { seg: makeWledSegments(strips, wledSegmentMap) });
                      setPushStatus('✓ Pushed');
                    } catch (err) {
                      setPushStatus(`Error: ${err.message}`);
                    }
                    setTimeout(() => setPushStatus(''), 3000);
                  }}>
                  Push to WLED
                </button>
                {pushStatus && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--accent)' }}>{pushStatus}</span>}
              </div>
            )}
          </Section>

          <Section title="Audio">
            <Row label="Microphone">
              <span style={{ fontSize: 'var(--fs-md)' }}>Enable via Audio toggle in toolbar</span>
            </Row>
            <div style={{ padding: '6px 0', fontSize: 'var(--fs-xs)', color: 'var(--text-4)' }}>
              Audio analysis feeds bass/mid/hi bands into pattern engine in real-time.
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
