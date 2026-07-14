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
      return { ...state, status: 'confirmed', confirmedRevision: state.pendingRevision, pendingRevision: null, error: '', conflictsDisabled: false };
    case 'fail':
      return { ...state, status: 'failed', error: action.error || 'Card did not confirm the action.', conflictsDisabled: false };
    case 'retry':
      return state.status === 'failed' ? { ...state, status: 'pending', error: '', conflictsDisabled: true } : state;
    case 'reset':
      return createCardActionState({ confirmedRevision: state.confirmedRevision });
    default:
      return state;
  }
}
