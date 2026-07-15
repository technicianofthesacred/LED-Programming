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
  complete: ['Complete', 'Card is ready', 'Installation and verification completed.', 'Inspect another card'],
  'recovery-required': ['Recovery required', 'No card changes were made', 'Reconnect the card and inspect it again. If an install was interrupted, follow the recovery procedure.', 'Inspect again'],
});

let currentState = 'select-card';
let confirmationToken = null;

function render(payload = {}) {
  currentState = views[payload.state] ? payload.state : 'recovery-required';
  const [marker, title, fallbackMessage, button] = views[currentState];
  stateMarker.textContent = marker;
  stateTitle.textContent = title;
  stateMessage.textContent = payload.message || fallbackMessage;
  primaryAction.textContent = button;
  confirmationToken = payload.confirmationToken || confirmationToken;
  const critical = currentState === 'installing' || currentState === 'verifying';
  primaryAction.disabled = critical || currentState === 'inspect';
  cancelAction.disabled = critical;
  cancelAction.hidden = currentState === 'select-card' || currentState === 'complete';
  progress.hidden = !critical;
  progressBar.style.width = `${Number.isFinite(payload.progress) ? payload.progress : 0}%`;
}

primaryAction.addEventListener('click', async () => {
  try {
    if (currentState === 'confirm') {
      render(await bridge.confirmDestructiveAction(confirmationToken));
    } else if (currentState === 'complete') {
      render({ state: 'select-card' });
    } else {
      const inspected = await bridge.inspectCompatibleCard();
      if (inspected.compatible) render(await bridge.startOperation('install-firmware'));
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
