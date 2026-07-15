'use strict';

const STATES = new Set([
  'select-card', 'inspect', 'confirm', 'installing', 'verifying', 'complete', 'recovery-required',
]);
const CRITICAL_STATES = new Set(['installing', 'verifying']);

function createOperationState() {
  let state = 'select-card';
  return Object.freeze({
    get current() { return state; },
    transition(next) {
      if (!STATES.has(next)) throw new TypeError('Unknown operation state');
      state = next;
      return state;
    },
    reset() { state = 'select-card'; },
    isCritical() { return CRITICAL_STATES.has(state); },
    shouldPreventClose() { return CRITICAL_STATES.has(state); },
    cancel() {
      if (CRITICAL_STATES.has(state)) return false;
      state = 'select-card';
      return true;
    },
  });
}

module.exports = { createOperationState };
