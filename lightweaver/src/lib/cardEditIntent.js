// The card→Patterns handoff carries what the owner asked for in the query
// string: `?editPattern=aurora` or `?editLook=…`. The card screen reads it to
// decide whether to auto-open Patterns, and Patterns reads it to claim the
// authorization the card issued.
//
// A claim that fails has to STOP the auto-open, without erasing what the owner
// asked for. Patterns sends the owner back to the card when it cannot claim,
// and the card — seeing the same intent still in the URL — resolves the
// project and sends them straight back. Every hop remounts both screens, which
// resets any once-only guard either of them owns, so the loop has no exit and
// no rate limit: measured at ~45 resolutions per second, six HTTP requests
// each, aimed at the card on the owner's shelf, while the owner watched a
// disabled "Verifying project…".
//
// So the intent stays in the URL — `?editPattern=ocean` is still what they
// came for, and an explicit "Load this project" can still honour it — but a
// failed claim is remembered here, at module scope, where remounting cannot
// forget it. The card then offers the project instead of auto-opening it.

const INTENT_PARAMS = Object.freeze(['editPattern', 'editLook']);

let abandonedIntent = '';

export function readCardEditIntent(search = '') {
  const params = new URLSearchParams(String(search || ''));
  const pattern = String(params.get('editPattern') || '').trim();
  const look = String(params.get('editLook') || '').trim();
  if (pattern) return `pattern:${pattern}`;
  if (look) return `look:${look}`;
  return '';
}

// Patterns could not claim this intent. Record it so the card stops trying to
// hand it over on its own.
export function markCardEditIntentAbandoned(intent) {
  abandonedIntent = String(intent || '').trim();
}

export function isCardEditIntentAbandoned(intent) {
  const value = String(intent || '').trim();
  return value.length > 0 && value === abandonedIntent;
}

// A freshly issued authorization supersedes any past failure: the owner asked
// for this deliberately, so the handoff is allowed to proceed again.
export function clearAbandonedCardEditIntent() {
  abandonedIntent = '';
}

// The intent has been honoured and must not be replayed by a reload or a
// bookmark. Rewrites the query string only — the hash, and therefore the
// screen, is untouched.
export function searchWithoutCardEditIntent(search = '') {
  const params = new URLSearchParams(String(search || ''));
  let changed = false;
  for (const key of INTENT_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return null;
  const query = params.toString();
  return query ? `?${query}` : '';
}
