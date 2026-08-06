import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BENCH_DEFAULT_PORT_PIXELS,
  BENCH_MAX_MILLIAMPS,
  BENCH_RESERVED_CONTROL_PINS,
  BENCH_SKIP_MAX_OUTPUTS,
  benchSkipReasonText,
  buildBenchConfig,
} from '../../lib/benchConfig.js';
import {
  BEACON_PIN_RENEW_MS,
  pinBeaconPort,
  readBeaconPorts,
  releaseBeaconPort,
} from '../../lib/beaconProbe.js';
import { installBenchConfig, waitForClearedCard } from '../../lib/benchInstall.js';
import { clearCardProject } from '../../lib/cardClearProject.js';
import { getCardBridgeState } from '../../lib/cardBridge.js';
import {
  normalizeCardHost,
  readStoredCardHost,
} from '../../lib/cardConnection.js';
import { CARD_HARDWARE_CONTRACT } from '../../lib/cardHardwareContract.js';
import { FRAME_CHUNK_MAX_PIXELS, createCardFrameStream } from '../../lib/cardFrameStream.js';
import { normalizeCardReadiness } from '../../lib/cardReadiness.js';
import { DEFAULT_PRODUCTION_MAX_MILLIAMPS } from '../../lib/cardRuntimeContract.js';
import {
  PORT_ROLE_CONTROL,
  PORT_ROLE_STRIP,
  PORT_ROLE_UNUSED,
  normalizePortRoles,
} from '../../lib/portRoles.js';
import {
  DISCOVERY_FRAME_RATE_WARN_PIXELS,
  advance,
  buildChannelProofFrame,
  channelMapFromProofAnswers,
  correctFrameForChannelMap,
  createStripDiscoverySession,
  discoveryFrame,
  discoveryPortRoleUpdates,
  discoveryWarnings,
  totalDiscoveredPixels,
} from '../../lib/stripDiscovery.js';
import {
  clearDiscoveryRun,
  readDiscoveredPortRoles,
  readDiscoveryRun,
  writeDiscoveredPortRoles,
  writeDiscoveryRun,
} from '../../lib/stripDiscoveryStore.js';

// Find the strips.
//
// This is the first thing an owner does with a card, and it is the only screen
// that works on a card with nothing on it. The order is the owner's own: see
// what pixels exist -> identify which strips -> organize them -> patterns later.
//
// One card write happens here (the bench config). It is what takes the card out
// of factory-beacon mode, and after it everything is live frames — which is why
// the rest of the screen never touches card storage.

// Headroom the bench config provisions per port before anything is known. The
// probe can double past it; hitting the ceiling asks for a bigger bench rather
// than telling the owner their strip is too long.
const DISCOVERY_BENCH_HEADROOM = BENCH_DEFAULT_PORT_PIXELS;

// A flow id is only a binding token here: it ties the one-shot config authority
// to this page lifecycle and this card. Deliberately NOT minted through
// beginCardCommissioning — that would write a commissioning-registry artifact
// describing a firmware operation that is not happening.
function makeDiscoveryFlowId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `discovery${uuid.replace(/-/g, '')}`;
  } catch { /* fall through to the time/random form */ }
  return `discovery${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`.slice(0, 96);
}

function portLabel(port) {
  return `GPIO ${port.pin}`;
}

// How often the panel re-reads the frame stream's own delivery counters. The
// stream also calls onHealth after every pump (up to 18 times a second), so
// this poll exists for the one case onHealth cannot report: a stream that has
// never sent anything at all and therefore never emitted a report.
const STREAM_HEALTH_POLL_MS = 1000;

// A health report or a getStats() snapshot, reduced to the few facts the owner
// needs. failingForMs is bucketed to whole seconds so an 18 fps health stream
// re-renders at most once a second instead of eighteen times.
function summarizeStreamHealth(report = {}) {
  const failing = (Number(report.consecutiveFailures) || 0) > 0;
  const summary = {
    failing,
    failingForSeconds: Math.floor((Number(report.failingForMs) || 0) / 1000),
    // onHealth folds the truncation cause into `reason` while getStats does not,
    // so read it only when something actually failed. Truncation has its own
    // field and its own line — mixing them would flap the two sources against
    // each other once a second.
    reason: failing ? (report.lastError?.reason || report.reason || '') : '',
    truncated: Boolean(report.truncated),
    truncatedReason: report.truncatedReason || '',
  };
  // Only getStats() carries this; an onHealth report must leave whatever the
  // last snapshot recorded alone rather than resetting it to zero.
  if (Number.isFinite(report.sentFrames)) summary.sentFrames = report.sentFrames;
  return summary;
}

function sameStreamHealth(a, b) {
  if (!a || !b) return false;
  return a.failing === b.failing
    && a.failingForSeconds === b.failingForSeconds
    && a.reason === b.reason
    && a.truncated === b.truncated
    && a.truncatedReason === b.truncatedReason
    && a.sentFrames === b.sentFrames;
}

// Plain language for the transport's own reason codes. "Nothing is happening"
// has to read differently from "the strip is dark because it ends here" — that
// distinction is the entire point of a discovery walk.
// What Studio asked the card to hold, next to the ceiling it was measured
// against. Every way a bench install can be refused for size arrives here as
// one flat sentence ("The card refused the discovery setup."), which leaves the
// owner with nothing to change. These two numbers are the difference between a
// dead end and "pick fewer ports".
function benchSizeSentence(built, reportedMaxPixels) {
  const asked = `Studio asked this card to hold ${built.totalPixels} LEDs across `
    + `${built.layout.length} port(s)`;
  return reportedMaxPixels
    ? `${asked}, and the card reports it can hold ${reportedMaxPixels}.`
    : `${asked}. This card did not report a pixel ceiling of its own, so Studio worked to its own `
      + `${built.budget}-LED limit — an older card can hold far fewer. Try fewer ports.`;
}

function streamFailureText(reason) {
  switch (reason) {
    case 'relay-socket-closed':
      return 'the card page lost its connection to the card';
    case 'stream-superseded':
    case 'stream-reclaimed':
      return 'another tab or Studio screen took over this card';
    case 'transport-congested':
      return 'the connection to the card is congested';
    case 'ws-backoff':
    case 'ws-open-failed':
      return 'Studio cannot open a connection to the card';
    default:
      return 'Studio is not reaching the card';
  }
}

export function StripDiscoveryPanel({ cardHost = '', cardLink = null, go = null }) {
  const host = normalizeCardHost(cardHost || cardLink?.host || readStoredCardHost());
  const flowIdRef = useRef('');
  if (!flowIdRef.current) flowIdRef.current = makeDiscoveryFlowId();

  // Which ports to go looking on. Seeded from whatever discovery last recorded
  // so a second pass starts from the owner's own answers, and left entirely
  // unused otherwise: the card's compiled pin menu is far wider than the four
  // outputs it can actually drive, so guessing which ones are wired would both
  // waste the pixel budget and walk the owner through ports they never touched.
  const [portRoles, setPortRoles] = useState(readDiscoveredPortRoles);
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [failureDetail, setFailureDetail] = useState('');
  const [benchNotice, setBenchNotice] = useState('');
  const [recorded, setRecorded] = useState(false);
  // Which BenchInstallError stopped the run — 'staged-existing-project' gets
  // its own one-tap way out instead of the generic retry (ui-repair B0).
  const [failureReason, setFailureReason] = useState('');
  // A run a reload interrupted, offered back on the idle screen (ui-repair B2).
  const [interruptedRun, setInterruptedRun] = useState(readDiscoveryRun);
  // The two-question colour proof (ui-repair B-COLOUR). 'first'/'second' are
  // the open questions, 'done' carries the measured map, 'skipped' is the
  // owner's explicit opt-out (colours then behave exactly as before).
  const [channelProof, setChannelProof] = useState({ stage: 'first', firstSeen: '', map: null, retry: false });
  const [streamHealth, setStreamHealth] = useState(null);
  const streamRef = useRef(null);
  // The "look at your strip" question assumes the light holds steady while the
  // owner walks over and looks. If the card restarts in that window, the answer
  // they were about to give no longer describes reality — say so.
  const [cardRestartedDuringLook, setCardRestartedDuringLook] = useState(false);
  const lookBootIdRef = useRef('');

  // The ceiling the CARD reported, not Studio's. The firmware publishes it as
  // `limits.pixels` in every status envelope and normalizeCardReadiness is what
  // turns that into a number; null means this card never said, and
  // buildBenchConfig then falls back to the Studio contract bound. A card still
  // on pre-upgrade firmware answers 1024, and a bench config built past that is
  // refused outright — which is why this is read from the card rather than
  // assumed.
  const cardMaxPixels = normalizeCardReadiness(cardLink?.readiness || {}).maxPixels;
  // Added by the firmware workstream; older cards simply do not report it, and
  // its absence must never be read as "the limit is fine".
  const maxMilliampsSource = cardLink?.readiness?.maxMilliampsSource
    || cardLink?.card?.maxMilliampsSource
    || '';

  // Ports the picker is allowed to offer. A pin the shipped controls claim can
  // never become an LED output — buildBenchConfig skips it and the firmware's
  // discoveryPinAvailable() refuses it — so it must not be selectable at all.
  // The row is still rendered, labelled unavailable, rather than dropped: the
  // owner is looking at a physical card, and a port that silently vanishes from
  // the list reads as a Studio bug instead of an answer.
  const selectablePortRoles = useMemo(
    () => portRoles.filter(entry => !BENCH_RESERVED_CONTROL_PINS.includes(entry.pin)),
    [portRoles],
  );
  // Only the ports the owner asked Studio to look at get bench pixels. A port
  // left on "Skip" must be provisioned zero, otherwise the session would treat
  // it as discoverable and walk the owner through a port they said to leave
  // alone.
  const probeTargets = useMemo(
    () => selectablePortRoles.filter(entry => entry.role === PORT_ROLE_STRIP),
    [selectablePortRoles],
  );
  // Four is a silicon limit, not a policy: the ESP32-S3 has four RMT TX
  // channels, so a fifth output cannot be driven no matter how it is wired.
  // This is the one place discovery says "not that many" — and it is about
  // outputs, never about how long a strip may be.
  const overOutputLimit = probeTargets.length > CARD_HARDWARE_CONTRACT.maxOutputs;

  const bench = useMemo(() => {
    const pixelsPerPort = Object.fromEntries(probeTargets.map(entry => [
      entry.pin,
      Math.max(entry.pixelCount || 0, DISCOVERY_BENCH_HEADROOM),
    ]));
    return buildBenchConfig(portRoles, { pixelsPerPort, maxPixels: cardMaxPixels });
  }, [portRoles, probeTargets, cardMaxPixels]);

  // Ports that only overflow the 4-output silicon limit are reported once, in
  // the output-limit banner, instead of one near-identical line per port.
  const outputLimitSkips = bench.skipped.filter(entry => entry.reason === BENCH_SKIP_MAX_OUTPUTS);
  const otherSkips = bench.skipped.filter(entry => entry.reason !== BENCH_SKIP_MAX_OUTPUTS);

  // ── Port probe ─────────────────────────────────────────────────────────────
  // Before any setup is written, the owner usually already knows roughly where
  // they plugged the strip in. Waiting for the beacon sweep to reach that port
  // and trusting they read the timing right is a worse way to confirm it than
  // asking the port directly. So: click a port, the card lights it, they look.
  //
  // The card is the authority on which ports exist — a control pin claims its
  // GPIO, and that assignment lives in the card's own config, so Studio's
  // hardware contract would offer buttons this particular card cannot drive.
  //
  // The probe belongs to the idle screen only. Once a run starts, the bench
  // config takes the outputs over and the beacon is no longer driving anything.
  const phaseIsPastIdle = Boolean(session) && session.phase !== 'idle';
  const [probePorts, setProbePorts] = useState(null);
  const [pinnedPort, setPinnedPort] = useState(null);
  const [probeError, setProbeError] = useState('');
  const pinnedPortRef = useRef(null);
  pinnedPortRef.current = pinnedPort;

  useEffect(() => {
    if (phaseIsPastIdle) return undefined;
    let cancelled = false;
    readBeaconPorts(host, { bridgeVersion: getCardBridgeState().version })
      .then(result => { if (!cancelled) setProbePorts(result); })
      // A card that cannot answer simply gets no grid; the sweep still runs and
      // the role pickers below are unaffected.
      .catch(() => { if (!cancelled) setProbePorts(null); });
    return () => { cancelled = true; };
  }, [host, phaseIsPastIdle]);

  // The firmware drops a pin on its own so a closed tab cannot park the card on
  // one port forever. Re-assert while the owner is still looking at it.
  useEffect(() => {
    if (pinnedPort === null) return undefined;
    const timer = setInterval(() => {
      pinBeaconPort(host, pinnedPort, { bridgeVersion: getCardBridgeState().version })
        .catch(() => {});
    }, BEACON_PIN_RENEW_MS);
    return () => clearInterval(timer);
  }, [host, pinnedPort]);

  // Hand the card back to advertising itself the moment this screen stops
  // asking about a port — on unmount, or once the real discovery run begins and
  // takes the outputs over.
  useEffect(() => () => {
    if (pinnedPortRef.current !== null) {
      releaseBeaconPort(host, { bridgeVersion: getCardBridgeState().version });
    }
  }, [host]);
  useEffect(() => {
    if (!phaseIsPastIdle || pinnedPortRef.current === null) return;
    releaseBeaconPort(host, { bridgeVersion: getCardBridgeState().version });
    setPinnedPort(null);
  }, [phaseIsPastIdle, host]);

  const probePort = useCallback(async pin => {
    setProbeError('');
    // Clicking the lit port again turns it off, so the owner can stop a probe
    // without leaving the screen.
    if (pinnedPort === pin) {
      setPinnedPort(null);
      await releaseBeaconPort(host, { bridgeVersion: getCardBridgeState().version });
      return;
    }
    try {
      const result = await pinBeaconPort(host, pin, { bridgeVersion: getCardBridgeState().version });
      if (!result.ok) {
        setProbeError(`This card cannot light GPIO ${pin} right now.`);
        setPinnedPort(null);
        return;
      }
      setPinnedPort(pin);
    } catch (error) {
      setProbeError(error?.message || `Studio could not reach the card to light GPIO ${pin}.`);
      setPinnedPort(null);
    }
  }, [host, pinnedPort]);

  const noteStreamHealth = useCallback(report => {
    setStreamHealth(current => {
      const next = { ...(current || {}), ...summarizeStreamHealth(report) };
      return sameStreamHealth(current, next) ? current : next;
    });
  }, []);

  // The phases where the card should be showing a Studio frame. Outside them a
  // dark strip means nothing, so no delivery claim is made either.
  const lighting = Boolean(session) && ['probe', 'decade', 'end-marker'].includes(session.phase);

  // A changed bootId is the card's own report that it restarted. Only watched
  // while a question is on screen; deliberate restarts (Extend and keep
  // looking) reset the baseline below so they never raise this notice.
  const cardBootId = cardLink?.readiness?.bootId || '';
  useEffect(() => {
    if (!lighting) {
      lookBootIdRef.current = '';
      setCardRestartedDuringLook(false);
      return;
    }
    if (!cardBootId) return;
    if (!lookBootIdRef.current) {
      lookBootIdRef.current = cardBootId;
      return;
    }
    if (cardBootId !== lookBootIdRef.current) {
      lookBootIdRef.current = cardBootId;
      setCardRestartedDuringLook(true);
    }
  }, [lighting, cardBootId]);

  // The stream is created once per session and torn down with it. Stopping
  // releases the card's frame-source claim through the existing control path,
  // so the card's own bench look resumes rather than freezing on a probe frame.
  useEffect(() => {
    if (!session || session.phase === 'bench-install' || session.phase === 'done') return undefined;
    if (!streamRef.current) {
      // Without onHealth a strip receiving nothing looks exactly like a strip
      // that ends where the light stops — the one confusion this whole screen
      // exists to remove.
      streamRef.current = createCardFrameStream({ host, onHealth: noteStreamHealth });
      streamRef.current.start();
    }
    return undefined;
  }, [session?.phase, host, noteStreamHealth]);

  // onHealth only fires after a pump that actually tried to send. A stream that
  // has never been handed a frame stays silent forever, which is precisely the
  // "nothing is happening" case the owner must be able to see, so the counters
  // are read directly too.
  useEffect(() => {
    if (!lighting) return undefined;
    const timer = setInterval(() => {
      const stats = streamRef.current?.getStats?.();
      if (stats) noteStreamHealth(stats);
    }, STREAM_HEALTH_POLL_MS);
    return () => clearInterval(timer);
  }, [lighting, noteStreamHealth]);

  useEffect(() => () => {
    const stream = streamRef.current;
    streamRef.current = null;
    void stream?.stop();
  }, []);

  // The frame actually sent to the card. While a colour-proof question is open
  // the probe run is lit in a single pure send-channel (the owner's answer IS
  // the colour-order measurement); once answered, every discovery frame is
  // corrected through the measured map so the hues the instructions name are
  // the hues on the physical strip (ui-repair B-COLOUR).
  const outgoingFrame = useCallback(() => {
    if (session?.phase === 'probe' && session.activePin !== null
      && (channelProof.stage === 'first' || channelProof.stage === 'second')) {
      const port = session.ports.find(item => item.pin === session.activePin);
      return buildChannelProofFrame({
        benchLayout: session.benchLayout,
        pin: session.activePin,
        litCount: port?.litCount || 0,
        step: channelProof.stage,
      });
    }
    return correctFrameForChannelMap(discoveryFrame(session), channelProof.map);
  }, [session, channelProof]);

  // Frames are pushed, not sent: the stream owns the throttle, the keepalive,
  // and (after chunking) the splitting of a long frame into card-sized writes.
  useEffect(() => {
    const frame = outgoingFrame();
    if (frame && streamRef.current) streamRef.current.push(frame);
  }, [outgoingFrame]);

  const dispatch = useCallback(event => setSession(current => advance(current, event)), []);

  // ui-repair B2: a reload mid-run used to lose everything while the card kept
  // playing the bench setup. The session is plain serializable data by design,
  // so every question phase is persisted verbatim and offered back on the next
  // visit. Completion clears it.
  useEffect(() => {
    if (!session) return;
    if (session.phase === 'done') {
      clearDiscoveryRun();
      return;
    }
    writeDiscoveryRun({ host, session, channelProof });
  }, [session, channelProof, host]);

  const resumeRun = () => {
    if (!interruptedRun) return;
    setFailure('');
    setFailureDetail('');
    setFailureReason('');
    if (interruptedRun.channelProof) setChannelProof(interruptedRun.channelProof);
    setSession(interruptedRun.session);
    setInterruptedRun(null);
  };

  const discardRun = () => {
    clearDiscoveryRun();
    setInterruptedRun(null);
  };

  // ui-repair B-COLOUR: the two colour-proof answers. The same colour twice is
  // physically impossible — one answer was a slip — so the check starts over
  // rather than recording a map that lies.
  const answerChannelProof = seen => {
    setChannelProof(current => {
      if (current.stage === 'first') {
        return { stage: 'second', firstSeen: seen, map: null, retry: false };
      }
      if (current.stage === 'second') {
        const map = channelMapFromProofAnswers(current.firstSeen, seen);
        if (!map) return { stage: 'first', firstSeen: '', map: null, retry: true };
        return { stage: 'done', firstSeen: current.firstSeen, map, retry: false };
      }
      return current;
    });
  };

  const skipChannelProof = () => setChannelProof({ stage: 'skipped', firstSeen: '', map: null, retry: false });

  // Explicit "show me again": re-push the current phase's frame and clear the
  // restart notice. The stream keepalive re-sends on its own; this exists so
  // the owner can force it after a doubt or a reboot without leaving the step.
  // It is also the gate that re-enables the answer buttons after a detected
  // restart (ui-repair B5).
  const relight = useCallback(() => {
    setCardRestartedDuringLook(false);
    const frame = outgoingFrame();
    if (frame && streamRef.current) streamRef.current.push(frame);
  }, [outgoingFrame]);

  const setPortRole = (pin, role) => setPortRoles(current => normalizePortRoles(
    current.map(entry => (entry.pin === pin ? { ...entry, role } : entry)),
  ));

  const startDiscovery = async () => {
    setBusy(true);
    setFailure('');
    setFailureDetail('');
    setFailureReason('');
    setBenchNotice('');
    setStreamHealth(null);
    // A fresh run replaces whatever interrupted run was stored (ui-repair B2).
    clearDiscoveryRun();
    setInterruptedRun(null);
    const next = createStripDiscoverySession({ portRoles, benchLayout: bench.layout });
    setSession(next);
    try {
      // installBenchConfig only resolves once the card has applied the config,
      // rebooted, and reported that it will accept playback. Anything else —
      // including the 'staged' answer from a card that still needs a firmware
      // update — throws, so the probe phase is never entered against a card
      // that cannot light a pixel.
      await installBenchConfig({
        host,
        config: bench.config,
        flowId: flowIdRef.current,
        initial: true,
        // The card's own pre-install claim. A staged answer on a card that
        // showed a project means "clear the card", never "update the
        // firmware" (ui-repair B0).
        cardShowsProject: Boolean(cardLink?.readiness?.projectId)
          || cardLink?.readiness?.knownGoodProject === true
          || cardLink?.readiness?.provisionalSetup === true,
      });
      setSession(current => advance(current, { type: 'bench-installed' }));
    } catch (error) {
      const message = error?.message || 'Studio could not set this card up for discovery.';
      setFailure(message);
      setFailureReason(error?.reason || '');
      // Size numbers explain a size refusal; on the existing-project cause
      // they would only bury the one action that helps.
      if (error?.reason !== 'staged-existing-project') {
        setFailureDetail(benchSizeSentence(bench, cardMaxPixels));
      }
      setSession(current => advance(current, { type: 'bench-failed', error: message }));
    } finally {
      setBusy(false);
    }
  };

  // ui-repair B0: the one-tap way out when the staged answer was caused by the
  // card already holding a project. Clear it (the card keeps its WiFi), wait
  // for the card to come back blank, then run the exact same start again.
  const clearCardAndRetry = async () => {
    setBusy(true);
    setFailure('');
    setFailureDetail('');
    try {
      await clearCardProject({ host });
      await waitForClearedCard({ host });
      setFailureReason('');
      setSession(null);
      setBusy(false);
      await startDiscovery();
      return;
    } catch (error) {
      setFailure(error?.message || 'Studio could not clear the card.');
      setBusy(false);
    }
  };

  const extendBench = async () => {
    // The card is Ready by now, so this is an ORDINARY commissioned config
    // write — no one-shot authority involved.
    setBusy(true);
    setFailure('');
    setFailureDetail('');
    setBenchNotice('');
    let larger = null;
    try {
      const pixelsPerPort = Object.fromEntries(session.ports
        .filter(port => port.role !== PORT_ROLE_CONTROL)
        .map(port => [port.pin, Math.max(port.provisioned * 2, DISCOVERY_BENCH_HEADROOM)]));
      larger = buildBenchConfig(portRoles, { pixelsPerPort, maxPixels: cardMaxPixels });
      // The card restarts to pick up the bigger pixel buffers, so the stream's
      // failure counters from the gap are stale the moment it returns.
      await installBenchConfig({ host, config: larger.config, flowId: flowIdRef.current });
      setStreamHealth(null);
      // This restart is deliberate; do not report it as the card changing
      // underneath the owner.
      lookBootIdRef.current = '';
      setCardRestartedDuringLook(false);
      // Doubling stops at the card's own ceiling, and pressing Extend again
      // after that changes nothing. Saying so is the difference between a real
      // answer and a button the owner presses forever.
      if (larger.totalPixels >= larger.budget) {
        setBenchNotice(`The card is now set up for ${larger.budget} LEDs, which is everything it can hold. `
          + 'If the strip still runs past the lit part, it is longer than this card can drive by itself — '
          + 'record what you can see and split the run across ports or a second card.');
      }
      dispatch({ type: 'bench-resized', benchLayout: larger.layout });
    } catch (error) {
      setFailure(error?.message || 'Studio could not extend the card setup.');
      if (larger) setFailureDetail(benchSizeSentence(larger, cardMaxPixels));
    } finally {
      setBusy(false);
    }
  };

  const record = () => {
    const merged = normalizePortRoles([
      ...discoveryPortRoleUpdates(session),
      ...portRoles,
    ]);
    setPortRoles(writeDiscoveredPortRoles(merged));
    setRecorded(true);
    dispatch({ type: 'recorded' });
    void streamRef.current?.stop();
    streamRef.current = null;
    setStreamHealth(null);
  };

  const warnings = discoveryWarnings(session);
  const activePort = session?.ports.find(port => port.pin === session.activePin) || null;
  const phase = session?.phase || 'idle';

  // Abandoning discovery mid-run leaves the card holding the temporary bench
  // setup with no project of the owner's on it (findings 2026-08-06, #1).
  // The browser cannot stop that, but it can make closing the tab deliberate.
  useEffect(() => {
    if (!phaseIsPastIdle || phase === 'done') return undefined;
    const warn = event => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phaseIsPastIdle, phase]);

  return (
    <div className="screen strip-discovery" data-testid="strip-discovery">
      <header className="panel-head">
        <span className="ttl">Find my strips</span>
        <span className="meta">{host || 'no card host'} · one-time card setup, then lights only</span>
      </header>

      {maxMilliampsSource === 'default' && (
        <p className="lw-card-banner is-inline" data-testid="discovery-power-warning" role="status">
          No power limit was ever set on this card, so it is using its built-in {DEFAULT_PRODUCTION_MAX_MILLIAMPS} mA
          fallback and will quietly dim the LEDs to stay under it. Set the real supply during commissioning.
          Nothing here is blocked by it — discovery runs at {BENCH_MAX_MILLIAMPS} mA on purpose.
        </p>
      )}

      {/* Whether Studio is actually driving the strip right now. Without this a
          strip receiving nothing looks exactly like a strip that ends where the
          light stops, and every answer the owner gives from here on is a guess. */}
      {lighting && (
        <div className="strip-discovery-stream" data-testid="discovery-stream-health">
          {streamHealth?.failing ? (
            <p className="lw-card-banner is-inline" role="alert" data-testid="discovery-stream-failing">
              Studio is not lighting the strip right now — {streamFailureText(streamHealth.reason)}
              {streamHealth.failingForSeconds > 0 ? ` (${streamHealth.failingForSeconds}s)` : ''}.
              A dark strip does not mean anything until this clears, so do not answer yet.
            </p>
          ) : streamHealth?.sentFrames === 0 ? (
            <p className="lw-card-banner is-inline" role="status" data-testid="discovery-stream-idle">
              Studio has not sent a frame to the card yet. Wait for the lights before answering.
            </p>
          ) : (
            <p className="strip-discovery-note" role="status" data-testid="discovery-stream-live">
              Studio is driving the strip. Whatever is dark on it is dark because the LEDs end there.
            </p>
          )}
          {streamHealth?.truncated && (
            <p className="lw-card-banner is-inline" role="status" data-testid="discovery-stream-truncated">
              {streamHealth.truncatedReason === 'bridge-frame-cap'
                ? `This card's firmware can only be sent ${FRAME_CHUNK_MAX_PIXELS} LEDs at a time, so anything past
                   LED ${FRAME_CHUNK_MAX_PIXELS} stays dark no matter how long the strip is. Update the card
                   firmware to walk the whole run.`
                : `Only part of each frame is reaching the card, so anything past the first
                   ${FRAME_CHUNK_MAX_PIXELS} LEDs stays dark. Treat the far end as unmeasured.`}
            </p>
          )}
          {cardRestartedDuringLook && (
            <p className="lw-card-banner is-inline" role="alert" data-testid="discovery-card-restarted">
              The card restarted while you were looking, so what the strip showed may have changed.
              The answer buttons are paused — light it again and take another look first.
            </p>
          )}
          <button type="button" className="btn" data-testid="discovery-relight" onClick={relight}>
            Light these again
          </button>
        </div>
      )}

      {phase === 'idle' && (
        <section className="strip-discovery-step" data-testid="discovery-plan">
          {interruptedRun && (
            <div className="lw-card-banner is-inline" role="status" data-testid="discovery-resume">
              <p>
                A Find-my-strips run was interrupted before it finished, and the card is still
                holding its temporary setup. You can pick up exactly where you left off — the
                answers already given are kept.
              </p>
              <button type="button" className="btn primary" data-testid="discovery-resume-continue" onClick={resumeRun}>
                Pick up where I left off
              </button>
              <button type="button" className="btn" data-testid="discovery-resume-discard" onClick={discardRun}>
                Start over
              </button>
            </div>
          )}
          <h3>Which ports should Studio look at?</h3>
          <p>
            A port can carry a strip, a knob or slider, or nothing. Studio only lights the ports you
            leave set to a strip. Pick up to {CARD_HARDWARE_CONTRACT.maxOutputs} — that is how many
            strip outputs this card can drive at once.
          </p>
          {probePorts?.available && (
            <p className="strip-discovery-note" data-testid="discovery-probe-hint">
              Not sure which port your strip is on? Press <b>Light it</b> and look — the card lights
              {' '}{probePorts.pixelsPerPort || BENCH_DEFAULT_PORT_PIXELS} LEDs on that port straight
              away. It stays dim and short until the setup below is written, because the card does
              not know your strip length or your power supply yet.
            </p>
          )}
          {probeError && (
            <p className="lw-card-banner is-inline" role="alert" data-testid="discovery-probe-error">
              {probeError}
            </p>
          )}
          <ul className="strip-discovery-ports">
            {portRoles.map(entry => (
              <li key={entry.pin}>
                <span>{portLabel(entry)}</span>
                {BENCH_RESERVED_CONTROL_PINS.includes(entry.pin) ? (
                  <span
                    className="strip-discovery-port-unavailable"
                    data-testid={`discovery-port-unavailable-${entry.pin}`}
                  >
                    In use by the controls
                  </span>
                ) : (
                  <>
                    {probePorts?.available && probePorts.ports.includes(entry.pin) && (
                      <button
                        type="button"
                        className={`btn strip-discovery-probe${pinnedPort === entry.pin ? ' is-lit' : ''}`}
                        data-testid={`discovery-probe-${entry.pin}`}
                        aria-pressed={pinnedPort === entry.pin}
                        onClick={() => probePort(entry.pin)}
                      >
                        {pinnedPort === entry.pin ? 'Lit — turn off' : 'Light it'}
                      </button>
                    )}
                    <select
                      aria-label={`${portLabel(entry)} role`}
                      value={entry.role}
                      onChange={event => setPortRole(entry.pin, event.target.value)}
                    >
                      <option value={PORT_ROLE_STRIP}>Look for a strip</option>
                      <option value={PORT_ROLE_CONTROL}>Physical control</option>
                      <option value={PORT_ROLE_UNUSED}>Skip</option>
                    </select>
                  </>
                )}
              </li>
            ))}
          </ul>
          {overOutputLimit && (
            <p className="lw-card-banner is-inline" role="alert" data-testid="discovery-output-limit">
              This card can drive {CARD_HARDWARE_CONTRACT.maxOutputs} strip outputs at once
              {outputLimitSkips.length > 0
                ? `, so ${outputLimitSkips.map(entry => `GPIO ${entry.pin}`).join(', ')} will not be lit`
                : ''}. Pick at most
              {' '}{CARD_HARDWARE_CONTRACT.maxOutputs}, or use a second card for the rest.
            </p>
          )}
          {otherSkips.length > 0 && (
            <ul className="strip-discovery-skipped" data-testid="discovery-skipped">
              {otherSkips.map(entry => (
                <li key={entry.pin} role="status" data-testid={`discovery-skipped-${entry.pin}`}>
                  GPIO {entry.pin} will not be lit — {benchSkipReasonText(entry.reason)}.
                </li>
              ))}
            </ul>
          )}
          {probeTargets.length > 0 && !bench.config && (
            <p className="lw-card-banner is-inline" role="alert" data-testid="discovery-no-outputs">
              None of the ports you picked can be set up as an LED output, so there is nothing for
              Studio to light. Pick a port from the list above that is not in use by the controls.
            </p>
          )}
          <button
            type="button"
            className="btn primary"
            data-testid="discovery-start"
            onClick={startDiscovery}
            disabled={busy || probeTargets.length === 0 || overOutputLimit || !bench.config}
          >
            {busy ? 'Setting the card up…' : 'Start finding strips'}
          </button>
          <p className="strip-discovery-note" data-testid="discovery-start-note">
            This writes one temporary setup to the card — {DISCOVERY_BENCH_HEADROOM} LEDs per chosen
            port — so it can light LEDs at all. The card keeps playing that setup, even after a
            restart, until your own project replaces it at the end.
          </p>
        </section>
      )}

      {phase === 'bench-install' && (
        <section className="strip-discovery-step" data-testid="discovery-installing">
          {session.error ? (
            // The install failed, so the card is still in whatever state it was
            // in. Saying "setting the card up" here — the old behaviour — reads
            // as progress and leaves the owner waiting on something that already
            // stopped.
            <>
              <h3>The card could not be set up</h3>
              <p data-testid="discovery-install-error">{session.error}</p>
              {failureReason === 'staged-existing-project' && (
                <button
                  type="button"
                  className="btn primary"
                  data-testid="discovery-clear-and-retry"
                  onClick={() => void clearCardAndRetry()}
                  disabled={busy}
                >
                  {busy ? 'Clearing the card…' : 'Clear the card and start again'}
                </button>
              )}
              <button type="button" className="btn" data-testid="discovery-install-retry" onClick={() => setSession(null)} disabled={busy}>
                Back to the port list
              </button>
            </>
          ) : (
            <>
              <h3>Setting the card up</h3>
              <p>Keep the card powered. It restarts once, then the lights answer immediately.</p>
            </>
          )}
        </section>
      )}

      {phase === 'probe' && activePort && (
        <section className="strip-discovery-step" data-testid="discovery-probe">
          <h3>{portLabel(activePort)} — how far do the lights go?</h3>
          <p>
            Studio lit the first <strong data-testid="discovery-lit-count">{activePort.litCount}</strong> LEDs
            on this port. Look at the strip.
          </p>
          {benchNotice && (
            <p className="lw-card-banner is-inline" role="status" data-testid="discovery-bench-maxed">
              {benchNotice}
            </p>
          )}
          {(channelProof.stage === 'first' || channelProof.stage === 'second') && (
            <div className="lw-card-banner is-inline" role="status" data-testid="discovery-color-proof">
              <p>
                {channelProof.stage === 'first'
                  ? 'First, a quick colour check so every colour used later can be trusted: the lit LEDs are all showing ONE colour right now. What colour do you see?'
                  : 'One more: Studio changed the lit LEDs to a different colour. What colour do you see now?'}
              </p>
              {channelProof.retry && (
                <p role="alert" data-testid="discovery-color-proof-retry">
                  Those two answers were the same colour, which cannot happen — one of them was a
                  slip. The check starts over: look again.
                </p>
              )}
              <div className="strip-discovery-actions">
                <button type="button" className="btn" data-testid="discovery-color-red" onClick={() => answerChannelProof('red')}>Red</button>
                <button type="button" className="btn" data-testid="discovery-color-green" onClick={() => answerChannelProof('green')}>Green</button>
                <button type="button" className="btn" data-testid="discovery-color-blue" onClick={() => answerChannelProof('blue')}>Blue</button>
                <button type="button" className="btn btn-ghost" data-testid="discovery-color-skip" onClick={skipChannelProof}>
                  I can’t tell — skip this
                </button>
              </div>
            </div>
          )}
          {activePort.needsLargerBench ? (
            <>
              <p className="lw-card-banner is-inline" role="status" data-testid="discovery-bench-ceiling">
                This strip runs past the {activePort.provisioned} LEDs the card is currently set up for.
                Extend the setup and keep going — length is never a problem here.
              </p>
              <button type="button" className="btn primary" onClick={extendBench} disabled={busy}>
                {busy ? 'Extending…' : 'Extend and keep looking'}
              </button>
            </>
          ) : (
            <div className="strip-discovery-actions">
              <button type="button" className="btn primary" data-testid="discovery-more" disabled={cardRestartedDuringLook} onClick={() => dispatch({ type: 'probe-more' })}>
                There are more lights past the end
              </button>
              <button type="button" className="btn" data-testid="discovery-enough" disabled={cardRestartedDuringLook} onClick={() => dispatch({ type: 'probe-enough' })}>
                The lit part covers the whole strip
              </button>
              <button type="button" className="btn btn-ghost" data-testid="discovery-skip" disabled={cardRestartedDuringLook} onClick={() => dispatch({ type: 'probe-skip' })}>
                Nothing lit up on this port
              </button>
            </div>
          )}
        </section>
      )}

      {phase === 'decade' && (
        <section className="strip-discovery-step" data-testid="discovery-decade">
          <h3>Read the count off the strip</h3>
          <p>
            Every 10th LED is green, every 50th blue, every 100th red. Count the reds, then the blues
            after the last red, then the greens after that, then the plain warm ones on the end.
          </p>
          <ul className="strip-discovery-counts">
            {session.ports.filter(port => port.probed && !port.skipped).map(port => (
              <li key={port.pin}>
                <label>
                  {portLabel(port)}
                  <input
                    type="number"
                    min="0"
                    inputMode="numeric"
                    aria-label={`${portLabel(port)} LED count`}
                    data-testid={`discovery-count-${port.pin}`}
                    value={port.count}
                    onFocus={event => event.target.select()}
                    onChange={event => dispatch({ type: 'set-count', pin: port.pin, count: event.target.value })}
                  />
                </label>
              </li>
            ))}
          </ul>
          <button type="button" className="btn primary" data-testid="discovery-counts-done" disabled={cardRestartedDuringLook} onClick={() => dispatch({ type: 'counts-entered' })}>
            Check the last LED
          </button>
        </section>
      )}

      {phase === 'end-marker' && activePort && (
        <section className="strip-discovery-step" data-testid="discovery-end-marker">
          <h3>{portLabel(activePort)} — is that the last LED?</h3>
          <p>
            One purple LED is lit at position <strong>{activePort.count}</strong>. It should be the very
            last light on this strip.
          </p>
          <div className="strip-discovery-actions">
            <button type="button" className="btn primary" data-testid="discovery-end-yes" disabled={cardRestartedDuringLook} onClick={() => dispatch({ type: 'end-marker-yes' })}>
              Yes, that is the last one
            </button>
            <button type="button" className="btn" data-testid="discovery-end-no" disabled={cardRestartedDuringLook} onClick={() => dispatch({ type: 'end-marker-no' })}>
              No, there are more
            </button>
          </div>
        </section>
      )}

      {phase === 'record' && (
        <section className="strip-discovery-step" data-testid="discovery-record">
          <h3>{totalDiscoveredPixels(session)} LEDs found</h3>
          <ul className="strip-discovery-counts">
            {session.ports.filter(port => port.confirmed && port.count > 0).map(port => (
              <li key={port.pin} data-testid={`discovery-result-${port.pin}`}>
                {portLabel(port)} · {port.count} LEDs
              </li>
            ))}
          </ul>
          <button type="button" className="btn primary" data-testid="discovery-record-save" onClick={record}>
            Save what we found
          </button>
        </section>
      )}

      {phase === 'done' && (
        <section className="strip-discovery-step" data-testid="discovery-done">
          <h3>Saved</h3>
          <p>The card is still holding the temporary setup. Build your layout, then install it to replace this.</p>
          <button type="button" className="btn primary" data-testid="discovery-open-layout" onClick={() => go?.('layout')}>
            Go to Layout
          </button>
        </section>
      )}

      {warnings.length > 0 && (
        <ul className="strip-discovery-warnings" data-testid="discovery-warnings">
          {warnings.map(warning => (
            <li key={`${warning.pin}:${warning.kind}`} role="status" data-testid={`discovery-warning-${warning.kind}`}>
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      {recorded && (
        <p className="strip-discovery-note" role="status">
          Recorded {totalDiscoveredPixels(session)} LEDs across {discoveryPortRoleUpdates(session).filter(entry => entry.pixelCount > 0).length} port(s).
          {totalDiscoveredPixels(session) > DISCOVERY_FRAME_RATE_WARN_PIXELS ? ' Long runs refresh slower — they still work.' : ''}
        </p>
      )}

      {failure && (
        <div className="card-connection-failure" role="alert" data-testid="discovery-failure">
          <p>{failure}</p>
          {/* Size is never the reason discovery stops for good, so the numbers
              sit under the card's own words rather than replacing them. */}
          {failureDetail && <p data-testid="discovery-failure-size">{failureDetail}</p>}
        </div>
      )}
    </div>
  );
}

export default StripDiscoveryPanel;
