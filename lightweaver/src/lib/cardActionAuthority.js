import {
  connectingCardAction,
  isTransientCardConnectionReason,
  nextCardConnectionAction,
} from './cardConnectionFlow.js';

// The single action verdict for the card surfaces (card-interaction
// consolidation, phase 3). `deriveCardLifecycle` is the diagnosis authority;
// this module turns that diagnosis plus the raw link, platform capabilities,
// owner intent, and connection evidence into the ONE next action a surface
// should render — absorbing what used to live in two places:
//
//  - nextCardConnectionAction's transport/capability routing and its
//    ACTION_COPY (imported, never duplicated), and
//  - the Connection Center's LIFECYCLE_OWNED_ACTIONS collapse, which let
//    eight lifecycle states override the flow's own answer.
//
// Two deliberate fork resolutions live here:
//
//  Fork 1 — a verified transport whose readiness evidence is still incomplete
//  is lifecycle `confirming`, and its verdict is the busy connecting
//  presentation (the flow's own copy), never "Needs attention".
//
//  Fork 2 — `popup-blocked` keeps its lifecycle diagnosis
//  (attention-required) but stays `retryable: true`, because reopening the
//  popup genuinely clears it.

// Lifecycle states whose diagnosis outranks whatever the connection flow
// derived from the raw link — verbatim from CardConnectionCenter's shim.
const LIFECYCLE_OWNED_ACTIONS = new Set([
  'recovering',
  'updating',
  'update-recovering',
  'update-rolled-back',
  'target-mismatch',
  'project-changed',
  'project-mismatch',
  'attention-required',
]);

const LIFECYCLE_ATTENTION_EXPLANATION = 'Studio is using the exact card, firmware-update, and installed-project evidence shown in Setup. Finish that recovery step before card controls are available.';

// Which surface owns the next step, encoding the shell's openCardControl
// routing: a ready card opens direct controls; a card whose diagnosis is a
// "Needs attention"/"Needs project" family lands in guided Setup (this is
// also the Setup↔Center loop-breaker — a connected exact card whose task is
// 'load-matching-project' must resolve in Setup, never in the Center, whose
// only exit routed straight back to Setup); everything else is a connection
// question for the Connection Center.
const SETUP_SURFACE_STATES = new Set([
  'target-mismatch',
  'project-changed',
  'update-required',
  'setup-required',
  'project-mismatch',
  'attention-required',
]);

export function cardSurfaceForLifecycle(lifecycle) {
  if (lifecycle?.state === 'ready') return 'card-control';
  if (lifecycle && SETUP_SURFACE_STATES.has(lifecycle.state)) return 'setup';
  return 'connection-center';
}

const TONES = Object.freeze({
  ready: 'connected',
  confirming: 'connecting',
  connecting: 'connecting',
  recovering: 'connecting',
  reconnecting: 'connecting',
  verifying: 'connecting',
  updating: 'connecting',
  'update-recovering': 'connecting',
  disconnected: 'disconnected',
  'found-unpaired': 'disconnected',
});

// Verbatim collapse from CardConnectionCenter.jsx (lifecycleConnectionAction):
// the flow's answer stands unless the lifecycle owns this state, in which
// case the diagnosis label leads and the only offered exit is Setup.
function lifecycleConnectionAction(lifecycle, flowAction) {
  if (!lifecycle || lifecycle.state === 'ready') return flowAction;
  if (lifecycle.state === 'wrong-card' && flowAction.id === 'wrong-card') return flowAction;
  if (!LIFECYCLE_OWNED_ACTIONS.has(lifecycle.state) && flowAction.id !== 'ready-local-card') return flowAction;
  return {
    id: 'lifecycle-attention',
    title: lifecycle.label,
    explanation: LIFECYCLE_ATTENTION_EXPLANATION,
  };
}

export function deriveCardAction({
  lifecycle = null,
  link = {},
  capabilities = {},
  intent = '',
  evidence = {},
} = {}) {
  const safeLink = link && typeof link === 'object' && !Array.isArray(link) ? link : {};
  const rememberedCard = evidence.rememberedCard || null;
  const discoveredCard = evidence.discoveredCard ?? safeLink.discoveredCard ?? null;
  const hasKnownCard = Boolean(safeLink.card?.id || safeLink.expectedCard?.id || rememberedCard?.id);
  // A "blank card" intent asks for the installation route even while a link
  // is half-alive, so the flow sees a disconnected link — unless the wrong
  // card answered, which always outranks intent.
  const actionLink = intent === 'blank-card' && safeLink.reason !== 'wrong-card'
    ? { state: 'disconnected', reason: safeLink.reason }
    : safeLink;
  const flowIntent = intent || (hasKnownCard ? 'working-card' : '');
  const flowAction = nextCardConnectionAction({
    link: actionLink,
    intent: flowIntent,
    capabilities,
    rememberedCard,
    discoveredCard,
    setupNetwork: evidence.setupNetwork,
    setupMode: evidence.setupMode,
  });

  let action = lifecycleConnectionAction(lifecycle, flowAction);
  // Fork 1: readiness evidence still in flight on a verified transport. The
  // raw link gives the flow nothing specific (its bare fallback), but this is
  // not a failure to recover from — it is Studio still checking, so it renders
  // as exactly that. A specific flow verdict (setup-network steps, an update
  // route) still wins.
  if (lifecycle?.state === 'confirming' && action.id === 'recoverable-failure' && !action.route) {
    action = connectingCardAction();
  }

  const diagnosis = lifecycle?.state || 'disconnected';
  const busy = action.busy === true || action.pending === true;
  // Fork 2 lives in the first clause: a transient link reason (popup-blocked
  // included) stays retryable even when the lifecycle diagnosis collapsed the
  // rendered action to attention.
  const retryable = isTransientCardConnectionReason(safeLink.reason)
    || (action.id === 'recoverable-failure' && action.pending !== true);

  return Object.freeze({
    diagnosis,
    actionId: action.id,
    title: action.title,
    explanation: action.explanation,
    primaryLabel: action.primaryLabel ?? '',
    tone: TONES[diagnosis] || 'failure',
    busy,
    retryable,
    secondaryAction: action.secondaryAction ? Object.freeze({ ...action.secondaryAction }) : null,
    surface: cardSurfaceForLifecycle(lifecycle),
    // Flow extras the Connection Center renders from, carried through so its
    // copy stays byte-identical.
    route: action.route || '',
    pending: action.pending === true,
    primaryDisabled: action.primaryDisabled === true,
    legacyId: action.legacyId || '',
  });
}
