// The non-destructive escape from a card stranded on the bench/provisional
// Find-my-strips project (discovery findings 2026-08-06 #1/#5b).
// POST /api/clear-project with the {"confirm":"CLEAR"} token erases only the
// saved project/wiring/discovery/recovery state — WiFi credentials and any
// owner rename survive on the card — then the card reboots into factory phase
// on the same network.
//
// Transport mirrors benchInstall.js/recoverCardLights: http/file Studio talks
// to the card directly (same guardDirectCardMutation identity gate as every
// other direct mutation); HTTPS Studio relays over the card-page bridge, where
// the 'clear-project' relay first shipped in bridge protocol v5 — older card
// firmware has no relay for it, so the caller gets an honest firmware-update
// message instead of a silent no-op.

import { getCardBridgeVersion, sendCardBridgeRequest } from './cardBridge.js';
import { canPushDirectlyToCard, cardHostToUrl } from './cardConnection.js';
import { guardDirectCardMutation } from './cardIdentity.js';

export const CLEAR_PROJECT_CONFIRM_TOKEN = 'CLEAR';
// LW_BRIDGE_VERSION 5 (LightweaverWeb.cpp) added the 'clear-project' relay.
export const CLEAR_PROJECT_MIN_BRIDGE_VERSION = 5;

export class ClearProjectError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'ClearProjectError';
    // 'bridge-too-old' | 'refused' | 'unacknowledged'
    this.reason = reason;
  }
}

function requireClearAcknowledgement(response) {
  if (response?.ok !== true) {
    throw new ClearProjectError(
      'unacknowledged',
      response?.error || 'The card did not confirm that the temporary setup was cleared.',
    );
  }
  return response;
}

async function postClearProjectDirect({ host, timeoutMs, fetchImpl, guardImpl }) {
  await guardImpl(host, { fetchImpl, timeoutMs });
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await doFetch(`${cardHostToUrl(host)}/api/clear-project`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: CLEAR_PROJECT_CONFIRM_TOKEN }),
      signal: ctrl.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      throw new ClearProjectError('refused', body?.error || `The card refused the clear (${response.status}).`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function clearCardProject({
  host,
  timeoutMs = 8000,
  direct = canPushDirectlyToCard(),
  fetchImpl,
  guardImpl = guardDirectCardMutation,
  bridgeRequestImpl = sendCardBridgeRequest,
  bridgeVersion = getCardBridgeVersion(),
} = {}) {
  if (direct) {
    return postClearProjectDirect({ host, timeoutMs, fetchImpl, guardImpl });
  }
  if (bridgeVersion < CLEAR_PROJECT_MIN_BRIDGE_VERSION) {
    throw new ClearProjectError(
      'bridge-too-old',
      'This card is running older firmware that cannot clear the temporary setup from here. '
      + 'Update the card from the Install screen first, or install your project to replace the temporary setup.',
    );
  }
  const response = await bridgeRequestImpl(
    'clear-project',
    { confirm: CLEAR_PROJECT_CONFIRM_TOKEN },
    { host, timeoutMs },
  );
  return requireClearAcknowledgement(response);
}
