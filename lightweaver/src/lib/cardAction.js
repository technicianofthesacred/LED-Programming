export const PHYSICAL_PREVIEW_FAILURE_MESSAGE = 'The Studio preview changed, but the physical lights did not. Reconnect and retry.';

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
