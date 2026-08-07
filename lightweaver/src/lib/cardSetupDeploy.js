// The one way a setup reaches the card.
//
// Every dead end found while walking the real flow on real hardware is answered
// here, so no screen has to rediscover them:
//
//  - A card streaming frames cannot serve its own HTTP API. The browser reports
//    "could not reach the card" while the card sits there working perfectly. Put
//    the lights down first.
//  - A card that has just rebooted answers /api/status seconds before it will
//    accept a write. Wait for two clean reads, and treat an abort as "ask again",
//    never as "this failed".
//  - A wiring change the card is still holding open blocks every later write with
//    "wiring transaction is active; confirm or roll back before saving", and no
//    screen offers a way out. Roll the stale one back before writing.
//  - Staging exists to protect a layout the card is already running well. It must
//    be ACTIVATED and then CONFIRMED — activation alone starts a timed trial the
//    card silently undoes, so the setup looks installed and then is not.
//  - The reconnect watcher gives up long before a healthy card finishes booting.
//    Its timeout is not the outcome. The card's own report of what it is driving
//    is the only proof that counts.
import { pushConfigToCard } from './cardPushClient.js';
import { readCardStatusEnvelope } from './cardPushClient.js';
import {
  activateAndWaitForCardWiring,
  confirmCardWiringCandidate,
  getCardWiringStatus,
  rollbackCardWiringCandidate,
} from './cardWiringSafety.js';
import { reclaimCardFrameStreams } from './cardFrameStream.js';

const SETTLE_MS = 900;
const POLL_MS = 1500;
const RETRY_MS = 4000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function looksLikeCard(status) {
  return Boolean(status && (status.app === 'Lightweaver' || status.cardId));
}

// Aborts and reachability errors mean "ask again". A refusal the card actually
// reasoned about — a project mismatch, a staged change — is never transient and
// must surface unchanged.
export function isTransientCardError(error) {
  if (error?.name === 'AbortError') return true;
  // Only a STRING code is one of ours. A DOMException carries a numeric code
  // (AbortError is 20), and reading that as a refusal turned every "the card is
  // still booting" into "the card did not take the setup".
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code && code !== 'http' && code !== 'network') return false;
  return /abort|network|fetch|reach|timed out|timeout/i.test(String(error?.message || ''));
}

export async function waitForCardToAnswer(host, { attempts = 20 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      if (looksLikeCard(await readCardStatusEnvelope({ host }))) {
        // Two clean reads in a row: one can land in the gap between the radio
        // coming up and the card being ready to be written to.
        await sleep(SETTLE_MS);
        if (looksLikeCard(await readCardStatusEnvelope({ host }))) return true;
      }
    } catch { /* still starting */ }
    await sleep(POLL_MS);
  }
  return false;
}

// Poll until the card reports the length just sent. This is the proof: the card
// saying, itself, what it is now driving.
export async function waitForCardPixels(host, wanted, { attempts = 20 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const status = await readCardStatusEnvelope({ host });
      if (Number(status?.led?.pixels ?? status?.pixels ?? 0) === wanted) return true;
    } catch { /* a rebooting card does not answer; keep waiting */ }
    await sleep(POLL_MS);
  }
  return false;
}

export async function clearDanglingWiringTransaction(host) {
  try {
    const status = await getCardWiringStatus({ host });
    const activationId = status?.activationId;
    if (!activationId) return false;
    if (status.state !== 'staged' && status.state !== 'testing') return false;
    await rollbackCardWiringCandidate(activationId, { host });
    await waitForCardToAnswer(host);
    return true;
  } catch {
    // Nothing dangling, or the card cannot say. The write itself will tell us.
    return false;
  }
}

export function totalPixelsInPackage(runtimePackage) {
  return (runtimePackage?.config?.led?.outputs || [])
    .reduce((sum, output) => sum + (Number(output.pixels) || 0), 0);
}

/**
 * Send a runtime package to the card and do not return until the card itself
 * confirms it is driving that setup.
 *
 * onProgress receives short plain-English lines for the owner.
 * Throws when the card refuses for a real reason, or when it never comes back
 * reporting the setup that was sent.
 */
export async function deploySetupToCard(runtimePackage, host, {
  onProgress = null,
  allowProjectChange = false,
} = {}) {
  try { await reclaimCardFrameStreams(host); } catch { /* nothing was streaming */ }
  await waitForCardToAnswer(host);
  await clearDanglingWiringTransaction(host);

  const push = () => pushConfigToCard(runtimePackage, { host, allowLayoutChange: true, allowProjectChange });
  let response;
  try {
    response = await push();
  } catch (error) {
    if (!isTransientCardError(error)) throw error;
    onProgress?.('The card was still starting up. Trying again…');
    await sleep(RETRY_MS);
    await waitForCardToAnswer(host);
    response = await push();
  }

  if (response?.state === 'staged' && response.activationId) {
    onProgress?.('Confirming the wiring with the card…');
    try {
      await activateAndWaitForCardWiring(response.activationId, { host });
    } catch { /* the watcher's timeout is not the outcome; verified below */ }
    try {
      await confirmCardWiringCandidate(response.activationId, { host });
    } catch {
      // A confirm that never landed leaves the card holding the change open,
      // which blocks every later write. Try once more once it has settled.
      await waitForCardToAnswer(host);
      try { await confirmCardWiringCandidate(response.activationId, { host }); } catch { /* verified below */ }
    }
  }

  const wanted = totalPixelsInPackage(runtimePackage);
  if (wanted > 0 && !(await waitForCardPixels(host, wanted))) {
    throw new Error('the card did not come back with this setup');
  }
  return response;
}

// Build the card document from what was DISCOVERED, ignoring the drawing.
//
// The drawing is aspirational until the owner has drawn their real piece; a fresh
// project ships a placeholder (GPIO 16, 44 lights) and a starter layout that has
// nothing to do with the strip in front of them. Building the card from that is
// how a card ends up driving a port nothing is plugged into, or a length that does
// not exist. When the strip has been measured, the measurement wins.
export function outputsFromPortRoles(portRoles, maxOutputs = 4) {
  return (Array.isArray(portRoles) ? portRoles : [])
    .filter(entry => entry?.role === 'strip' && Number(entry.pixelCount) > 0)
    .slice(0, maxOutputs)
    .map((entry, index) => ({
      id: `out${index + 1}`,
      name: `Output ${index + 1}`,
      pin: Number(entry.pin),
      pixels: Number(entry.pixelCount),
    }));
}

export function buildPackageForPortRoles({
  projectId = '',
  projectName = 'Lightweaver Piece',
  // A revision is what makes prepareCardDeployment compute a project fingerprint.
  // Without one the card is written with an EMPTY fingerprint, and every screen
  // that asks "is this card running the project I have open?" answers no — which
  // silently disables Install on card and blocks live preview on a card that is
  // otherwise perfectly ready.
  projectRevision = 0,
  standaloneController = {},
  portRoles = [],
  maxOutputs = 4,
} = {}, prepareImpl) {
  const outputs = outputsFromPortRoles(portRoles, maxOutputs);
  return prepareImpl({
    projectId,
    projectName,
    projectRevision: Number.isSafeInteger(projectRevision) && projectRevision >= 0 ? projectRevision : 0,
    standaloneController: { ...standaloneController, outputs },
  }, {});
}
