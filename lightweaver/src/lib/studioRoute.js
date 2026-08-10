// The URL hash is the single source of truth for which Studio screen is
// showing, and for which section of the card workspace is open.
//
// It used to share that job with a React `view` state, reconciled by an
// effect. Two writers, one meaning: in-app navigation moved the state and let
// the effect move the URL, while twenty-odd screens navigate by assigning
// window.location.hash directly. A hash assignment moves the URL immediately
// but delivers `hashchange` a task later, so between those two moments the
// state was stale — and an effect that reconciled from stale state stamped the
// old screen back over the destination. That is how the card's "continue to
// Patterns" handoff died: the owner picked a project, the URL became
// #screen=pattern, and the shell rewrote it to #screen=card before the
// listener ever ran.
//
// Deriving `view` from the hash removes the second writer instead of trying to
// referee it. Everything here is a pure function of a hash string, so
// reconciliation is idempotent: applying it to an already-canonical route is a
// no-op, and there is no stored state left to be stale.

export const DEFAULT_CARD_SECTION = 'overview';
export const FIRST_RUN_CARD_SECTION = 'setup';
const CARD_SECTION_KEYS = new Set(['setup', 'overview', 'install', 'settings', 'workshop', 'support', 'preferences']);
const SETUP_TASK_KEYS = new Set([
  'connect-card', 'pair-card', 'reconnect-card', 'recover-operation',
  'update-firmware', 'configure-wifi', 'install-project', 'discover-lights',
  'place-lights', 'verify-direction', 'test-and-save', 'confirm-visible-lights',
  'load-matching-project', 'open-patterns',
]);

// Screens that were their own rail destination before the card workspace
// absorbed them. Every link, bookmark and printed handoff card carrying one
// still resolves, and a legacy hash is left in the URL as written rather than
// rewritten to its canonical form — `installRouteRef` and the install lock
// both compare against the exact string the owner arrived on.
export const LEGACY_CARD_SCREENS = new Set(['flash', 'settings', 'installer', 'production', 'setup']);

export const STUDIO_ROUTE_EVENT = 'lw-studio-route';

function routeParams(hash) {
  const body = String(hash || '').replace(/^#/, '');
  // `#v3` and other bare fragments are not routes; parsing them would invent a
  // `screen` key out of the fragment name.
  return new URLSearchParams(body.includes('=') ? body : '');
}

export function isCardSection(section) {
  return CARD_SECTION_KEYS.has(section);
}

export function isBridgeCallbackHash(hash) {
  return String(hash || '').startsWith('#bridge-result?');
}

export function cardRouteFromHash(hash = '') {
  const params = routeParams(hash);
  const screen = String(params.get('screen') || '').toLowerCase();
  if (screen === 'flash') {
    return params.get('mode') === 'install'
      ? { section: 'install', supportTool: '' }
      : { section: 'support', supportTool: 'technician' };
  }
  if (screen === 'installer') return { section: 'support', supportTool: 'guide' };
  if (screen === 'production') return { section: 'workshop', supportTool: '' };
  if (screen === 'settings') return { section: 'preferences', supportTool: '' };
  // #screen=setup was its own rail destination before the merge.
  if (screen === 'setup') return { section: 'setup', supportTool: '' };
  const section = params.get('section');
  const safeSection = CARD_SECTION_KEYS.has(section) ? section : DEFAULT_CARD_SECTION;
  if (safeSection === 'setup') {
    const task = String(params.get('task') || '');
    return { section: safeSection, supportTool: '', task: SETUP_TASK_KEYS.has(task) ? task : '' };
  }
  return { section: safeSection, supportTool: '' };
}

export function normalizeStudioView(value, { screenKeys = [], fallbackView = 'layout' } = {}) {
  const requested = String(value || '').trim().toLowerCase();
  if (requested === 'patterns') return 'pattern';
  if (LEGACY_CARD_SCREENS.has(requested)) return 'card';
  return screenKeys.includes(requested) ? requested : fallbackView;
}

export function studioViewFromHash(hash, options = {}) {
  // A bridge callback lands mid-handoff on a hash that names no screen. It
  // resolves to Layout, where the connection center opens over the piece.
  if (isBridgeCallbackHash(hash)) return 'layout';
  const screen = routeParams(hash).get('screen');
  return normalizeStudioView(screen || options.fallbackView, options);
}

// The route the given hash SHOULD be, once the screen it names is settled.
// Pure and idempotent — `canonicalStudioHash(canonicalStudioHash(h, v), v)`
// equals `canonicalStudioHash(h, v)`.
export function canonicalStudioHash(hash, view) {
  const params = routeParams(hash);
  const screen = String(params.get('screen') || '').toLowerCase();
  // Leave a legacy card entrance exactly as the owner arrived on it.
  if (view === 'card' && LEGACY_CARD_SCREENS.has(screen)) return String(hash || '');
  params.set('screen', view);
  if (view === 'card') {
    if (!isCardSection(params.get('section'))) params.set('section', DEFAULT_CARD_SECTION);
    params.delete('mode');
    if (params.get('section') !== 'setup' || !SETUP_TASK_KEYS.has(params.get('task'))) params.delete('task');
  } else {
    params.delete('section');
    params.delete('task');
  }
  // `mode` is the Layout screen's deep link (#screen=layout&mode=draw|wire) and
  // means nothing anywhere else. `install` is not one of the two modes.
  if (view !== 'layout' || params.get('mode') === 'install') params.delete('mode');
  return `#${params.toString()}`;
}

// A subscribable view of window.location.hash.
//
// history.replaceState fires no `hashchange`, so in-app navigation has to send
// its own notification — synchronously, so that a caller which navigates and
// then reads the route back sees where it just went.
export function createStudioRouteStore(win = globalThis) {
  const read = () => String(win.location?.hash || '');
  const subscribe = listener => {
    win.addEventListener('hashchange', listener);
    win.addEventListener(STUDIO_ROUTE_EVENT, listener);
    return () => {
      win.removeEventListener('hashchange', listener);
      win.removeEventListener(STUDIO_ROUTE_EVENT, listener);
    };
  };
  const replace = hash => {
    const next = String(hash || '').startsWith('#') ? String(hash) : `#${hash || ''}`;
    if (read() === next) return false;
    try {
      win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}${next}`);
    } catch {
      // Without history access the hash assignment is the only route we have;
      // it fires its own hashchange.
      win.location.hash = next;
      return true;
    }
    win.dispatchEvent(new Event(STUDIO_ROUTE_EVENT));
    return true;
  };
  return { read, subscribe, replace };
}
