// Installing the bench config — the ONE card write in the discovery flow, and
// the wait that proves it actually landed.
//
// The blank card is exempted from the wiring-staging path IN FIRMWARE: the
// candidate/probation machinery exists to protect a known-good layout from a
// bad rewire, and a card with nothing on it has no known-good layout to
// protect. So a blank card answers the ordinary applied shape
// ({ ok: true, requiresReboot: true }), reboots, and comes back Ready.
//
// Two things this module refuses to do, both of them settled decisions:
//
//  1. It never treats { state: 'staged' } as success. A staged answer means the
//     card is on firmware that still files a blank card's first config as a
//     wiring candidate, so nothing was applied, the strip is still dark, and
//     the frames discovery is about to push would be refused. Studio surfaces
//     that as "update the card first" — it does NOT grow a stage/activate/
//     confirm dance to work around it, because the resulting probation flow
//     would be protecting a layout that does not exist.
//  2. It never returns before the card can actually play. The old code
//     resolved on the config POST's echo, so the panel entered the probe phase
//     against a card that was still rebooting; every probe frame was refused
//     and the owner read a dark strip as "no LEDs here". Apply -> reboot ->
//     poll until the card itself says playback is admitted -> only then frames.

import { classifyCardReadiness } from './cardReadiness.js';
import {
  authorizeBlankCardDiscoveryConfig,
  sendCardBridgeRequest,
} from './cardBridge.js';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
} from './cardConnection.js';
import { guardDirectCardMutation, readPersistedCardIdentity } from './cardIdentity.js';
import { readCardStatusEnvelope, requestCardReboot } from './cardPushClient.js';

// A card that has just been written and rebooted is unreachable for a few
// seconds (radio down, mDNS re-announcing), so every failed poll is expected
// rather than fatal. 40s is generously past a normal ESP32-S3 boot; past it the
// honest answer is "it did not come back", not a longer silence.
export const BENCH_READY_TIMEOUT_MS = 40_000;
export const BENCH_READY_POLL_INTERVAL_MS = 750;
export const BENCH_READY_STATUS_TIMEOUT_MS = 2_000;

export const BENCH_INSTALL_STAGED_MESSAGE = 'This card is running older firmware that files a blank '
  + 'card’s first setup as a staged wiring change instead of applying it, so its LEDs cannot be '
  + 'lit yet. Update the card firmware from the Flash screen, then run Find my strips again.';

// The OTHER reason a config comes back staged (ui-repair B0, observed live
// twice): the card already HOLDS a project — often the bench setup from an
// earlier abandoned run — so its wiring protection files the new bench layout
// as a candidate. That is not a firmware problem, and telling the owner to
// reflash cannot help. Deliberately no mention of firmware here.
export const BENCH_INSTALL_EXISTING_PROJECT_MESSAGE = 'This card is already holding a saved setup '
  + '— often the temporary one from an earlier Find-my-strips run — so it filed the discovery '
  + 'setup as a wiring change instead of applying it. Clear what is on the card (it keeps its '
  + 'WiFi), then discovery can start fresh.';

export const BENCH_INSTALL_CLEARED_TIMEOUT_MESSAGE = 'The card accepted the clear but did not come '
  + 'back blank. Check that it still has power, then try again.';

export const BENCH_INSTALL_TIMEOUT_MESSAGE = 'The card took the discovery setup but did not come '
  + 'back ready. Check that it still has power, then try again.';

export class BenchInstallError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'BenchInstallError';
    // 'no-config' | 'authority' | 'refused' | 'staged' | 'staged-existing-project'
    // | 'wrong-card' | 'not-ready' | 'not-cleared'
    this.reason = reason;
  }
}

// The firmware's staged envelope is { ok: true, state: 'staged', activationId,
// requiresReboot: false, requiresConfirmation: true }. `ok` is true on it, which
// is exactly why checking response.ok alone let the deadlock ship as "complete".
export function benchConfigWasStaged(response) {
  if (!response || typeof response !== 'object') return false;
  return response.state === 'staged' || response.requiresConfirmation === true;
}

// True when the card said the write only takes effect after a restart. The
// blank-card case always does (outputCount changes, and the pixel buffers are
// sized at boot), but an older card that applies live is honoured too.
function benchConfigNeedsReboot(response) {
  return response?.requiresReboot === true;
}

async function postBenchConfigDirect({ host, config, guardImpl, fetchImpl }) {
  // http/file Studio (local dev, or Studio served from the card): the same
  // identity guard every other direct mutation runs, then the ordinary
  // /api/config POST. No bridge authority is involved because there is no
  // bridge.
  await guardImpl(host, { fetchImpl });
  const doFetch = fetchImpl || globalThis.fetch;
  const response = await doFetch(`${cardHostToUrl(host)}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new BenchInstallError('refused', body?.error || 'The card refused the discovery setup.');
  }
  return body;
}

async function postBenchConfigOverBridge({ host, config, flowId, initial, authorizeImpl, bridgeRequestImpl }) {
  // HTTPS Studio: the bridge is the only transport, and a blank card refuses
  // every config except the one-shot initial write. See the STRIP-DISCOVERY
  // DELTA note in cardBridge.js for exactly how narrow that grant is.
  if (initial) {
    const granted = authorizeImpl({ host, flowId });
    if (!granted.ok) {
      throw new BenchInstallError('authority', granted.reason === 'card-not-blank'
        ? 'This card already has a project on it, so discovery does not need the one-time setup write. Reconnect the card and try again.'
        : 'Studio could not verify this card over the local card page. Open the card page once, then try again.');
    }
  }
  return bridgeRequestImpl('config', config, {
    host,
    ...(initial ? { commissioningFlowId: flowId } : {}),
    timeoutMs: 8000,
    reboot: true,
  });
}

// Poll until the card admits playback. `playbackAccess === 'ready'` is the exact
// condition cardBridge.js gates frames on (it sets bridgeRuntimePlaybackReady
// from the same field), so this waits for the real gate rather than a proxy for
// it. Reads that throw are the card still restarting and are not counted
// against anything except the deadline.
export async function waitForBenchPlayback({
  host,
  transport,
  fetchImpl,
  expectedCard = readPersistedCardIdentity(),
  statusImpl = readCardStatusEnvelope,
  waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  pollIntervalMs = BENCH_READY_POLL_INTERVAL_MS,
  timeoutMs = BENCH_READY_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    await waitImpl(pollIntervalMs);
    let readiness = null;
    try {
      const status = await statusImpl({
        host,
        transport,
        timeoutMs: BENCH_READY_STATUS_TIMEOUT_MS,
        fetchImpl,
      });
      readiness = classifyCardReadiness(status || {}, { expectedCard });
    } catch {
      /* still rebooting — keep waiting until the deadline */
    }
    if (readiness?.playbackAccess === 'ready') return readiness;
    // A different card answering is never going to resolve by waiting, and
    // lighting it would be lighting a stranger's piece.
    if (readiness?.state === 'identity-mismatch') {
      throw new BenchInstallError('wrong-card', 'A different Lightweaver card answered at this address, so discovery stopped.');
    }
    if (now() >= deadline) {
      throw new BenchInstallError('not-ready', BENCH_INSTALL_TIMEOUT_MESSAGE);
    }
  }
}

// After POST /api/clear-project the card reboots into the blank factory phase
// with its WiFi kept. This waits until the card ITSELF answers as blank, so a
// retried discovery install never races the reboot. Same polling contract as
// waitForBenchPlayback: reads that throw are the card still restarting and
// count only against the deadline.
export async function waitForClearedCard({
  host,
  transport = canPushDirectlyToCard() ? 'direct' : 'bridge',
  fetchImpl,
  expectedCard = readPersistedCardIdentity(),
  statusImpl = readCardStatusEnvelope,
  waitImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  pollIntervalMs = BENCH_READY_POLL_INTERVAL_MS,
  timeoutMs = BENCH_READY_TIMEOUT_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    await waitImpl(pollIntervalMs);
    let readiness = null;
    try {
      const status = await statusImpl({
        host,
        transport,
        timeoutMs: BENCH_READY_STATUS_TIMEOUT_MS,
        fetchImpl,
      });
      readiness = classifyCardReadiness(status || {}, { expectedCard });
    } catch {
      /* still rebooting — keep waiting until the deadline */
    }
    if (readiness?.state === 'blank') return readiness;
    if (readiness?.state === 'identity-mismatch') {
      throw new BenchInstallError('wrong-card', 'A different Lightweaver card answered at this address, so discovery stopped.');
    }
    if (now() >= deadline) {
      throw new BenchInstallError('not-cleared', BENCH_INSTALL_CLEARED_TIMEOUT_MESSAGE);
    }
  }
}

/**
 * Install the bench config and return only once the card can actually play.
 *
 * `initial` distinguishes the ONE write a blank card will accept from every
 * later one. After the first install the card is Ready, so a re-size is an
 * ordinary commissioned config write and must NOT ask for the one-shot
 * authority again — that authority is spent by design.
 *
 * Throws BenchInstallError for every refusal, including the 'staged' answer
 * from a card that still needs a firmware update.
 */
export async function installBenchConfig({
  host,
  config,
  flowId,
  initial = false,
  // What Studio already knew about the card BEFORE this write: true when the
  // live status showed a project (projectId, knownGoodProject, or the new
  // firmware's provisionalSetup claim). A staged answer on such a card means
  // "the card is protecting an existing layout", not "the firmware is too old"
  // — the two need opposite advice (ui-repair B0).
  cardShowsProject = false,
  direct = canPushDirectlyToCard(),
  fetchImpl,
  guardImpl = guardDirectCardMutation,
  authorizeImpl = authorizeBlankCardDiscoveryConfig,
  bridgeRequestImpl = sendCardBridgeRequest,
  rebootImpl = requestCardReboot,
  waitForPlaybackImpl = waitForBenchPlayback,
  ...waitOptions
} = {}) {
  if (!config) {
    throw new BenchInstallError('no-config', 'None of the ports you picked can be set up as an LED output, so there is nothing to install.');
  }
  const transport = direct ? 'direct' : 'bridge';
  const response = direct
    ? await postBenchConfigDirect({ host, config, guardImpl, fetchImpl })
    : await postBenchConfigOverBridge({ host, config, flowId, initial, authorizeImpl, bridgeRequestImpl });

  if (benchConfigWasStaged(response)) {
    if (cardShowsProject) {
      throw new BenchInstallError('staged-existing-project', BENCH_INSTALL_EXISTING_PROJECT_MESSAGE);
    }
    throw new BenchInstallError('staged', BENCH_INSTALL_STAGED_MESSAGE);
  }

  // The card page's relay reboots on Studio's behalf for an applied config
  // (`shouldReboot` in LightweaverWeb.cpp) and reports it back as
  // `rebooting: true`. Direct HTTP has no relay, so Studio issues the reboot
  // itself — without this the card kept running the OLD pixel buffers and never
  // reached the new config at all.
  if (response?.rebooting !== true && benchConfigNeedsReboot(response)) {
    await rebootImpl(host, { fetchImpl });
  }

  await waitForPlaybackImpl({ host, transport, fetchImpl, ...waitOptions });
  return response;
}
