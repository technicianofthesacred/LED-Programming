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
  complete: ['Complete', 'Card acknowledged', 'Studio confirmed the stable card identity.', 'Inspect another card'],
  'recovery-required': ['Recovery required', 'Installation needs safe recovery', 'Reconnect the card, then recover the current signed release. The Bridge will not claim whether physical output is working.', 'Inspect for recovery'],
});

let currentState = 'select-card';
let confirmationToken = null;
let selectedOperation = 'install-current-release';

function render(payload = {}) {
  currentState = views[payload.state] ? payload.state : 'recovery-required';
  const [marker, title, fallbackMessage, button] = views[currentState];
  stateMarker.textContent = marker;
  stateTitle.textContent = title;
  stateMessage.textContent = payload.message || fallbackMessage;
  primaryAction.textContent = button;
  confirmationToken = payload.confirmationToken || confirmationToken;
  if (currentState === 'recovery-required') selectedOperation = 'recover-current-release';
  if (currentState === 'complete' || currentState === 'awaiting-card-acknowledgement') selectedOperation = 'install-current-release';
  const critical = currentState === 'installing' || currentState === 'verifying';
  primaryAction.disabled = critical || currentState === 'inspect' || currentState === 'usb-ownership-uncertain';
  cancelAction.disabled = critical;
  cancelAction.hidden = ['select-card', 'complete', 'awaiting-card-acknowledgement', 'operation-failed', 'usb-ownership-uncertain'].includes(currentState);
  progress.hidden = !critical;
  progressBar.style.width = `${Number.isFinite(payload.progress) ? payload.progress : 0}%`;
}

primaryAction.addEventListener('click', async () => {
  try {
    if (currentState === 'confirm') {
      render(await bridge.confirmDestructiveAction(confirmationToken));
    } else if (['complete', 'awaiting-card-acknowledgement', 'operation-failed', 'usb-ownership-uncertain'].includes(currentState)) {
      render({ state: 'select-card' });
    } else {
      const inspected = await bridge.inspectCompatibleCard();
      if (inspected.compatible) render(await bridge.startOperation(selectedOperation));
      else render(inspected);
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
render({ state: 'select-card' });
