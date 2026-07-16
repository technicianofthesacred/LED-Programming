'use strict';

const bridge = window.lightweaverBridge;
const stateMarker = document.querySelector('#state-marker');
const stateTitle = document.querySelector('#state-title');
const stateMessage = document.querySelector('#state-message');
const primaryAction = document.querySelector('#primary-action');
const cancelAction = document.querySelector('#cancel-action');
const progress = document.querySelector('#progress');
const progressBar = document.querySelector('#progress-bar');

const views = Object.freeze({
  'select-card': ['Select card', 'Connect a Lightweaver card', 'Plug the card into USB, then inspect it.', 'Inspect connected card'],
  inspect: ['Inspect', 'Inspecting card', 'Reading the connected card identity and compatibility.', 'Inspecting…'],
  confirm: ['Confirm', 'Confirm firmware installation', 'Installing firmware replaces the card configuration. Confirm only if this is the intended card.', 'Confirm and install'],
  installing: ['Installing', 'Installing firmware', 'Keep the card connected. This critical section cannot be cancelled.', 'Installing…'],
  verifying: ['Verifying', 'Verifying installation', 'Checking the installed firmware before releasing the card.', 'Verifying…'],
  'awaiting-card-acknowledgement': ['Flash verified', 'Reconnect in Studio', 'The factory image was verified, but the card and physical lights are not yet acknowledged. Reconnect in Studio to finish.', 'Inspect another card'],
  'operation-failed': ['Not changed', 'Inspect again', 'No card changes were confirmed. Inspect the card again before retrying.', 'Inspect again'],
  'usb-ownership-uncertain': ['USB uncertain', 'Restart the Bridge', 'USB release could not be confirmed. Close and restart the Bridge before retrying.', 'Restart required'],
  'callback-delivery-failed': ['Return pending', 'Return to Studio', 'Studio could not be opened. Retry the secure return without rerunning the card operation.', 'Return to Studio'],
  'return-pending': ['Return pending', 'Return to Studio', 'The result is saved until the originating Studio acknowledges it.', 'Return to Studio again'],
  'callback-returned': ['Returned', 'Returned to Studio', 'The existing card result was returned to Studio. No card operation was rerun.', 'Returned'],
  'launch-expired': ['Expired', 'Website request expired', 'This website request expired. Return to Studio and try again.', 'Dismiss'],
  complete: ['Complete', 'Card acknowledged', 'Studio confirmed the stable card identity.', 'Inspect another card'],
  'recovery-required': ['Recovery required', 'Installation needs safe recovery', 'Reconnect the card, then recover the current signed release. The Bridge will not claim whether physical output is working.', 'Inspect for recovery'],
});

let currentState = 'select-card';
let confirmationToken = null;
let selectedOperation = 'install-current-release';

function render(payload = {}) {
  currentState = views[payload.state] ? payload.state : 'recovery-required';
  let [marker, title, fallbackMessage, button] = views[currentState];
  if (payload.nextAction === 'unplug-replug-card') {
    marker = 'Reconnect';
    title = 'Reconnect the card';
    fallbackMessage = 'Unplug the card USB, wait a few seconds, reconnect it, then choose Inspect connected card.';
    button = 'I reconnected the card';
  }
  stateMarker.textContent = marker;
  stateTitle.textContent = title;
  stateMessage.textContent = payload.nextAction === 'unplug-replug-card' ? fallbackMessage : payload.message || fallbackMessage;
  primaryAction.textContent = button;
  confirmationToken = payload.confirmationToken || confirmationToken;
  if (currentState === 'recovery-required') selectedOperation = 'recover-current-release';
  if (currentState === 'complete' || currentState === 'awaiting-card-acknowledgement') selectedOperation = 'install-current-release';
  const critical = currentState === 'installing' || currentState === 'verifying';
  primaryAction.disabled = critical || currentState === 'inspect' || currentState === 'usb-ownership-uncertain'
    || currentState === 'callback-returned';
  cancelAction.disabled = critical;
  cancelAction.hidden = ['select-card', 'complete', 'awaiting-card-acknowledgement', 'operation-failed', 'usb-ownership-uncertain',
    'callback-delivery-failed', 'return-pending', 'callback-returned', 'launch-expired'].includes(currentState);
  progress.hidden = !critical;
  progressBar.style.width = `${Number.isFinite(payload.progress) ? payload.progress : 0}%`;
}

primaryAction.addEventListener('click', async () => {
  try {
    if (currentState === 'launch-expired') {
      render(await bridge.dismissExpiredLaunch());
    } else if (currentState === 'callback-delivery-failed' || currentState === 'return-pending') {
      render(await bridge.retryStudioCallback());
    } else if (currentState === 'select-card' && ['inspect-compatible-card', 'release-usb', 'restart-card'].includes(selectedOperation)) {
      render({ state: 'inspect', message: `${selectedOperation.replaceAll('-', ' ')} is running. Keep the card connected.` });
      render(await bridge.runMaintenanceOperation(selectedOperation));
    } else if (currentState === 'confirm') {
      render(await bridge.confirmDestructiveAction(confirmationToken));
    } else if (['complete', 'awaiting-card-acknowledgement', 'operation-failed', 'usb-ownership-uncertain'].includes(currentState)) {
      render({ state: 'select-card' });
    } else {
      const inspected = selectedOperation === 'install-current-release' || selectedOperation === 'recover-current-release'
        ? await bridge.inspectForOperation(selectedOperation)
        : await bridge.inspectCompatibleCard();
      if (inspected.compatible && (selectedOperation === 'install-current-release' || selectedOperation === 'recover-current-release')) {
        render(await bridge.startOperation(selectedOperation));
      } else render(inspected);
    }
  } catch {
    render({ state: 'recovery-required', message: 'The local bridge could not complete that step. No further action was taken.' });
  }
});

cancelAction.addEventListener('click', async () => {
  const result = await bridge.cancelBeforeCriticalSection();
  if (result.cancelled) render({ state: 'select-card' });
});

bridge.onProgress(render);
bridge.onResult(render);
bridge.onCallbackDelivery(render);
bridge.onLaunchRequest(({ operation }) => {
  selectedOperation = operation;
  render({
    state: 'select-card',
    message: `Studio requested ${operation.replaceAll('-', ' ')}. Inspect the connected card; the Bridge will still require confirmation before any destructive action.`,
  });
  primaryAction.textContent = ({
    'install-current-release': 'Inspect before install',
    'recover-current-release': 'Inspect before recovery',
    'inspect-compatible-card': 'Inspect connected card',
    'release-usb': 'Release USB safely',
    'restart-card': 'Restart connected card',
  })[operation];
});
render({ state: 'select-card' });
