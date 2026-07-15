'use strict';

const {
  createRendererResult,
  redactSensitiveText,
  validateOperation,
  validateToken,
} = require('./protocol');
const { isTrustedIpcEvent } = require('./security');

function createIpcHandlers({
  getActiveWindow,
  rendererPath,
  operation,
  inspectCard,
  createToken,
}) {
  let confirmationToken = null;

  function assertTrusted(event) {
    if (!isTrustedIpcEvent(event, getActiveWindow(), rendererPath)) {
      throw new Error('Untrusted renderer IPC sender');
    }
  }

  const handlers = {
    'bridge:inspect': async (event) => {
      assertTrusted(event);
      const inspectionAttempt = operation.beginInspection();
      const inspection = await inspectCard();
      const compatible = inspection && inspection.compatible === true;
      operation.completeInspection(inspectionAttempt, compatible);
      return createRendererResult('inspect', compatible
        ? 'Compatible Lightweaver card inspected.'
        : 'No compatible card selected. USB inspection is not implemented in this scaffold.', {
        compatible,
        productName: inspection && inspection.productName,
      });
    },
    'bridge:start-operation': async (event, requestedOperation) => {
      assertTrusted(event);
      validateOperation(requestedOperation);
      operation.startOperation();
      confirmationToken = createToken();
      return createRendererResult('confirm', 'Confirm that reinstalling firmware will replace the card configuration.', {
        confirmationToken,
      });
    },
    'bridge:confirm-destructive': async (event, token) => {
      assertTrusted(event);
      validateToken(token);
      if (!confirmationToken || token !== confirmationToken || operation.current !== 'confirm') {
        throw new Error('Confirmation token is expired or does not match');
      }
      confirmationToken = null;
      operation.enterCriticalSection();
      return createRendererResult('installing', 'Installation critical section entered. Keep the card connected.');
    },
    'bridge:cancel': async (event) => {
      assertTrusted(event);
      const cancelled = operation.cancel();
      if (cancelled) confirmationToken = null;
      return Object.freeze({ cancelled, state: operation.current });
    },
  };
  return Object.freeze(Object.fromEntries(Object.entries(handlers).map(([channel, handler]) => [
    channel,
    async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        throw new Error(redactSensitiveText(error && error.message) || 'Bridge operation failed');
      }
    },
  ])));
}

module.exports = { createIpcHandlers };
