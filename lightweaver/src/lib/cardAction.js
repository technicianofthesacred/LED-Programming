export const PHYSICAL_PREVIEW_FAILURE_MESSAGE = 'Studio changed, but the card did not verify that it applied the preview command. Reconnect and retry.';

const CARD_ACTION_FAILURES = Object.freeze({
  'identity-missing': Object.freeze({
    message: 'This card is running old software and cannot report which preview command it applied. Update the card, then retry.',
    actionId: 'update-card',
    actionLabel: 'Update card',
  }),
  'firmware-too-old': Object.freeze({
    message: 'This card is running old software and cannot report which preview command it applied. Update the card, then retry.',
    actionId: 'update-card',
    actionLabel: 'Update card',
  }),
  'wrong-card': Object.freeze({
    message: 'Studio reached a different Lightweaver card. Reconnect the expected card, or explicitly choose this card.',
    actionId: 'reconnect-card',
    actionLabel: 'Reconnect card',
  }),
  'bridge-missing': Object.freeze({
    message: 'The local card page is not open. Reopen it, then retry the preview command.',
    actionId: 'open-card-page',
    actionLabel: 'Open card page',
  }),
  timeout: Object.freeze({
    message: 'The card did not answer in time. Reconnect if needed, then retry the preview command.',
    actionId: 'retry',
    actionLabel: 'Retry',
  }),
  'card-rejected': Object.freeze({
    message: 'The card rejected the preview command. Open the card page to inspect the reported problem before retrying.',
    actionId: 'open-card-page',
    actionLabel: 'Open card page',
  }),
  'runtime-state-unconfirmed': Object.freeze({
    message: 'The preview reached the card, but its runtime did not report which pattern or revision it applied. Recover the lights, then verify them in person.',
    actionId: 'recover-lights',
    actionLabel: 'Recover lights',
  }),
  unknown: Object.freeze({
    message: 'The preview command could not be verified. Check the card connection and try again.',
    actionId: '',
    actionLabel: '',
  }),
});

const CARD_ACTION_FAILURE_ALIASES = Object.freeze({
  'bridge-timeout': 'timeout',
  'card-page-closed': 'timeout',
  offline: 'timeout',
  'no-answer': 'timeout',
  'preview-unconfirmed': 'card-rejected',
  'physical-output-unconfirmed': 'runtime-state-unconfirmed',
});

export function classifyCardActionFailure(error) {
  const code = [error?.reason, error?.code].reduce((recognized, value) => {
    if (recognized || typeof value !== 'string') return recognized;
    const canonical = CARD_ACTION_FAILURE_ALIASES[value] || value;
    return canonical !== 'unknown' && Object.hasOwn(CARD_ACTION_FAILURES, canonical) ? canonical : '';
  }, '') || 'unknown';
  return { code, ...CARD_ACTION_FAILURES[code] };
}

export function createCardActionState({ confirmedRevision = null } = {}) {
  return {
    status: 'idle',
    pendingRevision: null,
    confirmedRevision,
    error: '',
    conflictsDisabled: false,
  };
}

export function cardActionReducer(state, action) {
  switch (action.type) {
    case 'start':
      return { ...state, status: 'pending', pendingRevision: action.revision, error: '', conflictsDisabled: true };
    case 'confirm':
      if (action.revision !== undefined && action.revision !== state.pendingRevision) return state;
      return { ...state, status: 'confirmed', confirmedRevision: state.pendingRevision, pendingRevision: null, error: '', conflictsDisabled: false };
    case 'fail':
      if (action.revision !== undefined && action.revision !== state.pendingRevision) return state;
      return { ...state, status: 'failed', error: action.error || PHYSICAL_PREVIEW_FAILURE_MESSAGE, conflictsDisabled: false };
    case 'retry':
      return state.status === 'failed' ? { ...state, status: 'pending', error: '', conflictsDisabled: true } : state;
    case 'reset':
      return createCardActionState({ confirmedRevision: state.confirmedRevision });
    default:
      return state;
  }
}

export function cardActionStatusLabel(state = {}) {
  if (state.status === 'pending') return 'Sending to Lightweaver';
  if (state.status === 'confirmed') return 'Applied by Lightweaver runtime';
  return 'Previewing in Studio';
}
