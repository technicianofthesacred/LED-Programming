export function createOfflineUpdateController({
  runtimeMode,
  serviceWorker = globalThis.navigator?.serviceWorker,
  verifyShell = async () => true,
  hasActiveMutation = () => false,
  hasUnsavedTransition = () => false,
  reloadImpl = () => globalThis.location?.reload?.(),
} = {}) {
  let activeMutationGuard = hasActiveMutation;
  let unsavedTransitionGuard = hasUnsavedTransition;
  let watchingController = false;
  let state = Object.freeze({ status: runtimeMode?.kind === 'public-https' ? 'idle' : 'disabled', registration: null });
  const listeners = new Set();
  const setState = next => {
    state = Object.freeze({ ...state, ...next });
    listeners.forEach(listener => { try { listener(state); } catch { /* isolated */ } });
  };
  const inspectWaiting = registration => {
    if (registration?.waiting) setState({ status: 'update-waiting', registration, reason: '' });
  };
  return Object.freeze({
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setGuards(next = {}) {
      if (typeof next.hasActiveMutation === 'function') activeMutationGuard = next.hasActiveMutation;
      if (typeof next.hasUnsavedTransition === 'function') unsavedTransitionGuard = next.hasUnsavedTransition;
    },
    async register() {
      if (runtimeMode?.kind !== 'public-https' || !serviceWorker?.register) {
        setState({ status: 'disabled', registration: null });
        return state;
      }
      setState({ status: 'installing' });
      try {
        if (!watchingController && serviceWorker?.addEventListener) {
          watchingController = true;
          serviceWorker.addEventListener('controllerchange', () => {
            if (state.status !== 'activating') return;
            setState({ status: 'reloading' });
            reloadImpl();
          });
        }
        const registration = await serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
        setState({ registration });
        registration?.addEventListener?.('updatefound', () => setState({ status: 'installing', registration }));
        inspectWaiting(registration);
        if (!registration?.waiting) {
          await serviceWorker.ready;
          const ready = await verifyShell(registration);
          setState({ status: ready ? 'ready' : 'error', registration, reason: ready ? '' : 'shell-unverified' });
          inspectWaiting(registration);
        }
      } catch (error) {
        setState({ status: 'error', error });
      }
      return state;
    },
    activateUpdate() {
      const waiting = state.registration?.waiting;
      const mutation = activeMutationGuard();
      const unsaved = unsavedTransitionGuard();
      if (!waiting || mutation || unsaved) {
        // A refusal has to be VISIBLE. This used to re-set the same status with
        // a reason that only ever reached a title attribute, so the owner
        // pressed "Update ready", watched nothing happen, and reasonably read
        // the button as broken. The reason is now part of the state the label
        // is rendered from.
        setState({
          status: 'update-waiting',
          reason: !waiting ? 'no-update-waiting' : mutation ? 'card-operation-active' : 'unsaved-project-transition',
        });
        return false;
      }
      waiting.postMessage({ type: 'SKIP_WAITING' });
      setState({ status: 'activating', reason: '' });
      return true;
    },
  });
}
