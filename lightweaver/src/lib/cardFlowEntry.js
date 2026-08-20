// The single entry contract for "the owner wants something from the card".
//
// The Studio grew ~60 bespoke entry points into the card flows — footer chips
// that get DOM-clicked from other screens, hash strings assembled inline, and
// setup tasks reached by guessing the task id. Every caller now names an
// INTENT and this module decides, from the derived card lifecycle and setup
// journey, whether the caller may proceed in place, which hash to route to, or
// that the Connection Center should open. Resolution is a pure function so the
// decision table is testable without a DOM; `openCardFlow` is the thin
// executor that moves the URL or dispatches the connect-panel event.

import { setupTaskRoute } from './setupJourney.js';

// The Connection Center lives in the app shell. Screens used to open it by
// document.querySelector('[data-testid="card-link-status"]').click() — a DOM
// dependency on the footer chip's test id. The shell listens for this event
// instead, so any screen can ask for the panel without knowing the footer.
export const OPEN_CONNECT_PANEL_EVENT = 'lw-open-connect-panel';

export const CARD_FLOW_INTENTS = Object.freeze([
  'connect',
  'fix',
  'adopt-project',
  'push',
  'update-firmware',
  'install-project',
  'configure-wifi',
  'discover-strips',
  'recover-lights',
  'recover-operation',
  'edit-on-card',
  'batch',
]);

// Setup tasks that are answered by the Connection Center overlay rather than
// the Setup screen: the owner's problem is the link itself.
const CONNECT_PANEL_TASKS = new Set(['connect-card', 'pair-card', 'reconnect-card']);

const proceed = () => ({ action: 'proceed' });
const route = hash => ({ action: 'route', hash });
const connectPanel = connectIntent => ({ action: 'connect-panel', connectIntent });

function journeyTaskId({ lifecycle, journey }) {
  return journey?.taskId || journey?.nextAction?.taskId || lifecycle?.setupTaskId || '';
}

function journeyBlocked(journey) {
  return Array.isArray(journey?.blockers) && journey.blockers.length > 0;
}

function resolveFix(context) {
  const taskId = journeyTaskId(context);
  if (!taskId) return route('#screen=card&section=setup');
  return route(setupTaskRoute(taskId));
}

function resolveConnect(context) {
  const { lifecycle } = context;
  if (lifecycle?.state === 'ready') return proceed();
  const taskId = journeyTaskId(context);
  // A connected exact card whose remaining work is a project question
  // (load-matching-project, install-project, …) must go to the Setup task —
  // never back to the Connection Center, which is the ping-pong that made
  // "Find my card" send the owner in circles. Only a genuinely link-shaped
  // task (or a caller with no derived state at all, matching the legacy
  // footer-chip behaviour for unknown states) opens the panel.
  if (!taskId) return connectPanel('connect-card');
  if (CONNECT_PANEL_TASKS.has(taskId)) return connectPanel(taskId);
  return route(setupTaskRoute(taskId));
}

export function resolveCardIntent(intent, context = {}) {
  const { lifecycle, journey } = context;
  switch (intent) {
    case 'connect':
      return resolveConnect({ lifecycle, journey });
    case 'fix':
      return resolveFix({ lifecycle, journey });
    case 'adopt-project':
      return route(setupTaskRoute('load-matching-project'));
    case 'push':
      if (lifecycle?.commandReady === true && !journeyBlocked(journey)) return proceed();
      return resolveFix({ lifecycle, journey });
    case 'update-firmware':
    case 'install-project':
      return route('#screen=card&section=install');
    case 'configure-wifi':
      // Phase 6 refines this misdirect (Wi-Fi lives in setup, not install);
      // kept as-is for behavioural parity with today's entry points.
      return route('#screen=card&section=install');
    case 'discover-strips':
      return route('#screen=discovery');
    case 'recover-lights':
    case 'recover-operation':
      return route(setupTaskRoute('recover-operation'));
    case 'edit-on-card':
      // Preserving any ?editPattern/?editLook query intent is the caller's
      // job — this only names the destination section.
      return route('#screen=card&section=overview');
    case 'batch':
      return route('#screen=card&section=workshop');
    default:
      throw new TypeError(`Unknown card flow intent: ${String(intent)}`);
  }
}

export function openCardFlow(intent, context = {}) {
  const resolution = resolveCardIntent(intent, context);
  if (resolution.action === 'route') {
    window.location.hash = resolution.hash;
  } else if (resolution.action === 'connect-panel') {
    window.dispatchEvent(new CustomEvent(OPEN_CONNECT_PANEL_EVENT, {
      detail: { connectIntent: resolution.connectIntent },
    }));
  }
  return resolution;
}
