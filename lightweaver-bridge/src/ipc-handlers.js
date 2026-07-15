'use strict';

const { createRendererResult, redactSensitiveText, validateOperation, validateToken } = require('./protocol');
const { isTrustedIpcEvent } = require('./security');

const DESTRUCTIVE_OPERATIONS = new Set(['install-current-release', 'recover-current-release']);

function createIpcHandlers({ getActiveWindow, rendererPath, operation, runner }) {
  let pendingAuthority = null;

  function assertTrusted(event) {
    if (!isTrustedIpcEvent(event, getActiveWindow(), rendererPath)) throw new Error('Untrusted renderer IPC sender');
  }

  function sendIfStillTrusted(event, channel, payload) {
    if (isTrustedIpcEvent(event, getActiveWindow(), rendererPath)) event.sender.send(channel, payload);
  }

  function progressPayload(event) {
    const checkpoint = event.checkpoint;
    const verifying = checkpoint === 'flash-verification-completed' || checkpoint === 'card-restarted' || checkpoint === 'usb-released';
    if (verifying && operation.current === 'installing') operation.advanceVerification();
    return createRendererResult(verifying ? 'verifying' : 'installing', checkpoint.replaceAll('-', ' '), {
      progress: event.progress,
      code: checkpoint,
    });
  }

  const handlers = {
    'bridge:inspect': async (event) => {
      assertTrusted(event);
      pendingAuthority = null;
      const attempt = operation.beginInspection();
      const inspection = await runner.inspect();
      operation.completeInspection(attempt, inspection.compatible === true);
      return createRendererResult('inspect', 'Compatible Lightweaver card inspected. USB released.', inspection);
    },
    'bridge:start-operation': async (event, requestedOperation) => {
      assertTrusted(event);
      validateOperation(requestedOperation);
      if (!DESTRUCTIVE_OPERATIONS.has(requestedOperation)) throw new Error('Unsupported destructive bridge operation');
      const prepared = await runner.prepare(requestedOperation);
      operation.startOperation();
      pendingAuthority = Object.freeze({
        operation: requestedOperation,
        cardId: prepared.cardId,
        token: prepared.confirmationToken,
        sender: event.sender,
        senderFrame: event.senderFrame,
      });
      return createRendererResult('confirm', prepared.warning, prepared);
    },
    'bridge:confirm-destructive': async (event, token) => {
      assertTrusted(event);
      validateToken(token);
      if (!pendingAuthority || pendingAuthority.token !== token || pendingAuthority.sender !== event.sender
        || pendingAuthority.senderFrame !== event.senderFrame || operation.current !== 'confirm') {
        throw new Error('Confirmation token is expired or does not match');
      }
      const authority = pendingAuthority;
      pendingAuthority = null;
      operation.enterCriticalSection();
      Promise.resolve().then(() => runner.execute({
        operation: authority.operation,
        cardId: authority.cardId,
        token: authority.token,
        onEvent: progress => sendIfStillTrusted(event, 'bridge:progress', progressPayload(progress)),
      })).then(result => {
        if (operation.current === 'installing') operation.advanceVerification();
        operation.finish(true);
        sendIfStillTrusted(event, 'bridge:result', createRendererResult('complete', result.message, result));
      }).catch(error => {
        if (operation.current === 'installing') operation.failCriticalSection();
        else if (operation.current === 'verifying') operation.finish(false);
        sendIfStillTrusted(event, 'bridge:result', createRendererResult('recovery-required', error?.message || 'Installation interrupted.', {
          code: error?.code,
        }));
      });
      return createRendererResult('installing', 'Installation started. Keep the card connected.');
    },
    'bridge:cancel': async (event) => {
      assertTrusted(event);
      const cancelled = operation.cancel();
      if (cancelled) pendingAuthority = null;
      return Object.freeze({ cancelled, state: operation.current });
    },
  };

  return Object.freeze(Object.fromEntries(Object.entries(handlers).map(([channel, handler]) => [channel, async (...args) => {
    try { return await handler(...args); } catch (error) {
      throw new Error(redactSensitiveText(error?.message) || 'Bridge operation failed');
    }
  }])));
}

module.exports = { createIpcHandlers };
