'use strict';

const TRANSITIONS = Object.freeze({
  'select-card': Object.freeze(['inspect']),
  inspect: Object.freeze(['inspect', 'confirm', 'select-card']),
  confirm: Object.freeze(['installing', 'select-card']),
  installing: Object.freeze(['verifying', 'recovery-required']),
  verifying: Object.freeze(['complete', 'recovery-required']),
  complete: Object.freeze(['inspect', 'select-card']),
  'recovery-required': Object.freeze(['inspect', 'select-card']),
});
const CRITICAL_STATES = new Set(['installing', 'verifying']);

function createOperationState() {
  let state = 'select-card';
  let inspectionComplete = false;
  let compatible = false;
  let activeInspection = null;

  function transition(next) {
    if (!TRANSITIONS[state].includes(next)) {
      throw new Error(`Invalid operation transition from ${state} to ${next}`);
    }
    state = next;
    return state;
  }

  return Object.freeze({
    get current() { return state; },
    get hasCompatibleInspection() { return state === 'inspect' && inspectionComplete && compatible; },
    beginInspection() {
      transition('inspect');
      inspectionComplete = false;
      compatible = false;
      activeInspection = Symbol('inspection');
      return activeInspection;
    },
    completeInspection(inspection, isCompatible) {
      if (state !== 'inspect') throw new Error('Inspection can only complete from inspect state');
      if (!activeInspection || inspection !== activeInspection) throw new Error('Stale inspection result rejected');
      activeInspection = null;
      inspectionComplete = true;
      compatible = isCompatible === true;
      return compatible;
    },
    startOperation() {
      if (state !== 'inspect') throw new Error(`An inspection is required; invalid operation transition from ${state} to confirm`);
      if (!inspectionComplete) throw new Error('A completed inspection is required');
      if (!compatible) throw new Error('A compatible card inspection is required');
      return transition('confirm');
    },
    enterCriticalSection() {
      return transition('installing');
    },
    advanceVerification() {
      return transition('verifying');
    },
    finish(success) {
      return transition(success ? 'complete' : 'recovery-required');
    },
    failCriticalSection() {
      return transition('recovery-required');
    },
    reset() {
      if (CRITICAL_STATES.has(state)) throw new Error('Cannot reset during a critical operation');
      if (state !== 'select-card') transition('select-card');
      inspectionComplete = false;
      compatible = false;
      activeInspection = null;
      return state;
    },
    isCritical() { return CRITICAL_STATES.has(state); },
    shouldPreventClose() { return CRITICAL_STATES.has(state); },
    cancel() {
      if (CRITICAL_STATES.has(state)) return false;
      if (state !== 'select-card') transition('select-card');
      inspectionComplete = false;
      compatible = false;
      activeInspection = null;
      return true;
    },
  });
}

module.exports = { TRANSITIONS, createOperationState };
