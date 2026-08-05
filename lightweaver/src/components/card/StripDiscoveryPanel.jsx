import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BENCH_DEFAULT_PORT_PIXELS,
  BENCH_MAX_MILLIAMPS,
  BENCH_RESERVED_CONTROL_PINS,
  benchSkipReasonText,
  buildBenchConfig,
} from '../../lib/benchConfig.js';
import { installBenchConfig } from '../../lib/benchInstall.js';
import {
  normalizeCardHost,
  readStoredCardHost,
} from '../../lib/cardConnection.js';
import { CARD_HARDWARE_CONTRACT } from '../../lib/cardHardwareContract.js';
import { FRAME_CHUNK_MAX_PIXELS, createCardFrameStream } from '../../lib/cardFrameStream.js';
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
  createStripDiscoverySession,
  discoveryFrame,
  discoveryPortRoleUpdates,
  discoveryWarnings,
  totalDiscoveredPixels,
} from '../../lib/stripDiscovery.js';
import { readDiscoveredPortRoles, writeDiscoveredPortRoles } from '../../lib/stripDiscoveryStore.js';

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
  const [recorded, setRecorded] = useState(false);
  const [streamHealth, setStreamHealth] = useState(null);
  const streamRef = useRef(null);

  const cardMaxPixels = cardLink?.card?.maxPixels || cardLink?.readiness?.maxPixels;
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

  const noteStreamHealth = useCallback(report => {
    setStreamHealth(current => {
      const next = { ...(current || {}), ...summarizeStreamHealth(report) };
      return sameStreamHealth(current, next) ? current : next;
    });
  }, []);

  // The phases where the card should be showing a Studio frame. Outside them a
  // dark strip means nothing, so no delivery claim is made either.
  const lighting = Boolean(session) && ['probe', 'decade', 'end-marker'].includes(session.phase);

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

  // Frames are pushed, not sent: the stream owns the throttle, the keepalive,
  // and (after chunking) the splitting of a long frame into card-sized writes.
  useEffect(() => {
    const frame = discoveryFrame(session);
    if (frame && streamRef.current) streamRef.current.push(frame);
  }, [session]);

  const dispatch = useCallback(event => setSession(current => advance(current, event)), []);

  const setPortRole = (pin, role) => setPortRoles(current => normalizePortRoles(
    current.map(entry => (entry.pin === pin ? { ...entry, role } : entry)),
  ));

  const startDiscovery = async () => {
    setBusy(true);
    setFailure('');
    setStreamHealth(null);
    const next = createStripDiscoverySession({ portRoles, benchLayout: bench.layout });
    setSession(next);
    try {
      // installBenchConfig only resolves once the card has applied the config,
      // rebooted, and reported that it will accept playback. Anything else —
      // including the 'staged' answer from a card that still needs a firmware
      // update — throws, so the probe phase is never entered against a card
      // that cannot light a pixel.
      await installBenchConfig({ host, config: bench.config, flowId: flowIdRef.current, initial: true });
      setSession(current => advance(current, { type: 'bench-installed' }));
    } catch (error) {
      setFailure(error?.message || 'Studio could not set this card up for discovery.');
      setSession(current => advance(current, { type: 'bench-failed', error: error?.message }));
    } finally {
      setBusy(false);
    }
  };

  const extendBench = async () => {
    // The card is Ready by now, so this is an ORDINARY commissioned config
    // write — no one-shot authority involved.
    setBusy(true);
    setFailure('');
    try {
      const pixelsPerPort = Object.fromEntries(session.ports
        .filter(port => port.role !== PORT_ROLE_CONTROL)
        .map(port => [port.pin, Math.max(port.provisioned * 2, DISCOVERY_BENCH_HEADROOM)]));
      const larger = buildBenchConfig(portRoles, { pixelsPerPort, maxPixels: cardMaxPixels });
      // The card restarts to pick up the bigger pixel buffers, so the stream's
      // failure counters from the gap are stale the moment it returns.
      await installBenchConfig({ host, config: larger.config, flowId: flowIdRef.current });
      setStreamHealth(null);
      dispatch({ type: 'bench-resized', benchLayout: larger.layout });
    } catch (error) {
      setFailure(error?.message || 'Studio could not extend the card setup.');
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
        </div>
      )}

      {phase === 'idle' && (
        <section className="strip-discovery-step" data-testid="discovery-plan">
          <h3>Which ports should Studio look at?</h3>
          <p>
            A port can carry a strip, a knob or slider, or nothing. Studio only lights the ports you
            leave set to a strip.
          </p>
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
                  <select
                    aria-label={`${portLabel(entry)} role`}
                    value={entry.role}
                    onChange={event => setPortRole(entry.pin, event.target.value)}
                  >
                    <option value={PORT_ROLE_STRIP}>Look for a strip</option>
                    <option value={PORT_ROLE_CONTROL}>Physical control</option>
                    <option value={PORT_ROLE_UNUSED}>Skip</option>
                  </select>
                )}
              </li>
            ))}
          </ul>
          {overOutputLimit && (
            <p className="lw-card-banner is-inline" role="alert" data-testid="discovery-output-limit">
              This card can drive {CARD_HARDWARE_CONTRACT.maxOutputs} strip outputs at once. Pick at most
              {' '}{CARD_HARDWARE_CONTRACT.maxOutputs}, or use a second card for the rest.
            </p>
          )}
          {bench.skipped.length > 0 && (
            <ul className="strip-discovery-skipped" data-testid="discovery-skipped">
              {bench.skipped.map(entry => (
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
          <p className="strip-discovery-note">
            This writes one temporary setup to the card so it can light LEDs at all. Your own project
            replaces it at the end.
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
              <button type="button" className="btn" data-testid="discovery-install-retry" onClick={() => setSession(null)}>
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
              <button type="button" className="btn primary" data-testid="discovery-more" onClick={() => dispatch({ type: 'probe-more' })}>
                There are more lights past the end
              </button>
              <button type="button" className="btn" data-testid="discovery-enough" onClick={() => dispatch({ type: 'probe-enough' })}>
                The lit part covers the whole strip
              </button>
              <button type="button" className="btn btn-ghost" data-testid="discovery-skip" onClick={() => dispatch({ type: 'probe-skip' })}>
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
          <button type="button" className="btn primary" data-testid="discovery-counts-done" onClick={() => dispatch({ type: 'counts-entered' })}>
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
            <button type="button" className="btn primary" data-testid="discovery-end-yes" onClick={() => dispatch({ type: 'end-marker-yes' })}>
              Yes, that is the last one
            </button>
            <button type="button" className="btn" data-testid="discovery-end-no" onClick={() => dispatch({ type: 'end-marker-no' })}>
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

      {failure && <p className="card-connection-failure" role="alert" data-testid="discovery-failure">{failure}</p>}
    </div>
  );
}

export default StripDiscoveryPanel;
