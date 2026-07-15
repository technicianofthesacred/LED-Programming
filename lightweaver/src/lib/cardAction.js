export const PHYSICAL_PREVIEW_FAILURE_MESSAGE = 'The Studio preview changed, but the physical lights did not. Reconnect and retry.';

const CARD_ACTION_FAILURES = Object.freeze({
  'identity-missing': Object.freeze({
    message: 'This card is running old software and cannot confirm physical previews. Update the card, then retry.',
    actionId: 'update-card',
    actionLabel: 'Update card',
  }),
  'firmware-too-old': Object.freeze({
    message: 'This card is running old software and cannot confirm physical previews. Update the card, then retry.',
    actionId: 'update-card',
    actionLabel: 'Update card',
  }),
  'wrong-card': Object.freeze({
    message: 'Studio reached a different Lightweaver card. Reconnect the expected card, or explicitly choose this card.',
    actionId: 'reconnect-card',
    actionLabel: 'Reconnect card',
  }),
  'bridge-missing': Object.freeze({
    message: 'The local card page is not open. Reopen it, then retry the physical preview.',
    actionId: 'open-card-page',
    actionLabel: 'Open card page',
  }),
  timeout: Object.freeze({
    message: 'The card did not answer in time. Reconnect if needed, then retry the physical preview.',
    actionId: 'retry',
    actionLabel: 'Retry',
  }),
  'card-rejected': Object.freeze({
    message: 'The card rejected the physical preview. Open the card page to inspect the reported problem before retrying.',
    actionId: 'open-card-page',
    actionLabel: 'Open card page',
  }),
  'physical-output-unconfirmed': Object.freeze({
    message: 'The preview reached the card, but the lights did not confirm physical output. Verify the LED wiring or recover the lights.',
    actionId: 'recover-lights',
    actionLabel: 'Recover lights',
  }),
  unknown: Object.freeze({
    message: 'The physical preview could not be confirmed. Check the card connection and try again.',
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
});

export function classifyCardActionFailure(error) {
  const reportedCode = typeof error?.reason === 'string'
    ? error.reason
    : typeof error?.code === 'string'
      ? error.code
      : '';
  const code = CARD_ACTION_FAILURE_ALIASES[reportedCode] ||
    (Object.hasOwn(CARD_ACTION_FAILURES, reportedCode) ? reportedCode : 'unknown');
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
  if (state.status === 'confirmed') return 'Playing on Lightweaver';
  return 'Previewing in Studio';
}
