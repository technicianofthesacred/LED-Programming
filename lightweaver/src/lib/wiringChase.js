import { createCardFrameStream } from './cardFrameStream.js';

export const CHASE_FPS = 4;
export const CHASE_ACK_TIMEOUT_MS = 1500;
export const CHASE_MAX_CHANNEL = 26;

export function buildWiringChaseSteps(compiled = {}) {
  const runs = compiled.runs || [];
  return (compiled.outputs || []).flatMap(output => [
    { kind: 'output', outputId: output.id, label: output.name || output.id, pin: output.pin, start: output.start, count: output.count },
    ...runs.filter(run => run.outputId === output.id).map(run => ({
      ...run,
      kind: run.type === 'strip' ? 'run' : run.type,
      outputId: output.id,
      runId: run.id,
    })),
  ]);
}

export function buildWiringChaseFrame({ totalPixels = 0, step } = {}) {
  const frame = Array.from({ length: Math.max(0, totalPixels) }, () => '000000');
  if (!step || step.kind === 'cable' || step.kind === 'inactive') return frame;
  const start = Math.max(0, Number(step.start) || 0);
  const end = Math.min(frame.length, start + Math.max(0, Number(step.count) || 0));
  for (let index = start; index < end; index += 1) frame[index] = '001A00';
  if (start < end) frame[start] = '1A0000';
  return frame;
}

function completionTruth(state) {
  const outputIds = state.steps.filter(step => step.kind === 'output').map(step => step.outputId);
  const runIds = state.steps.filter(step => step.kind !== 'output').map(step => step.runId);
  return outputIds.every(id => state.confirmedOutputs.includes(id)) && runIds.every(id => Boolean(state.confirmedRuns[id]));
}

function withStep(state, stepIndex) {
  return { ...state, stepIndex: Math.max(0, Math.min(state.steps.length - 1, stepIndex)), delivery: 'idle', error: '', requestId: state.requestId + 1, firstPixelConfirmed: false };
}

export function createWiringChaseState(compiled = {}) {
  const steps = buildWiringChaseSteps(compiled);
  return { status: 'active', steps, stepIndex: 0, delivery: 'idle', error: '', requestId: 1, confirmedOutputs: [], confirmedRuns: {}, firstPixelConfirmed: false, corrections: [], canComplete: false };
}

export function wiringChaseReducer(state, action) {
  if (action.type === 'begin') return createWiringChaseState(action.compiled);
  if (!state || state.status !== 'active') return state;
  if (action.type === 'delivery') {
    if (action.requestId != null && action.requestId !== state.requestId) return state;
    const delivered = action.response?.ok !== false && action.response?.wsOpen !== false;
    return { ...state, delivery: delivered ? 'confirmed' : 'failed', error: delivered ? '' : (action.response?.error || 'Frame delivery failed.') };
  }
  if (action.type === 'retry') return { ...state, delivery: 'idle', error: '', requestId: state.requestId + 1 };
  if (action.type === 'previous') return withStep(state, state.stepIndex - 1);
  if (action.type === 'next') return withStep(state, state.stepIndex + 1);
  if (action.type === 'cancel') return { ...state, status: 'cancelled' };
  const step = state.steps[state.stepIndex];
  if (action.type === 'confirm-output') {
    if (state.delivery !== 'confirmed' || step?.kind !== 'output') return state;
    const confirmedOutputs = [...new Set([...state.confirmedOutputs, step.outputId])];
    const next = withStep({ ...state, confirmedOutputs }, state.stepIndex + 1);
    return { ...next, canComplete: completionTruth(next) };
  }
  if (action.type === 'confirm-first-pixel') {
    if (state.delivery !== 'confirmed' || step?.kind !== 'run') return state;
    return { ...state, firstPixelConfirmed: true };
  }
  if (action.type === 'confirm-direction') {
    if (state.delivery !== 'confirmed' || !state.firstPixelConfirmed || step?.kind !== 'run') return state;
    const confirmedRuns = { ...state.confirmedRuns, [step.runId]: true };
    const next = withStep({ ...state, confirmedRuns }, state.stepIndex + 1);
    return { ...next, canComplete: completionTruth(next) };
  }
  if (action.type === 'confirm-cable' || action.type === 'confirm-inactive') {
    const expectedKind = action.type === 'confirm-cable' ? 'cable' : 'inactive';
    if (state.delivery !== 'confirmed' || step?.kind !== expectedKind) return state;
    const confirmedRuns = { ...state.confirmedRuns, [step.runId]: true };
    const next = withStep({ ...state, confirmedRuns }, state.stepIndex + 1);
    return { ...next, canComplete: completionTruth(next) };
  }
  if (action.type === 'reverse-direction') {
    const targetIndex = action.stepIndex ?? state.stepIndex;
    const target = state.steps[targetIndex];
    if (target?.kind !== 'run' || (action.stepIndex == null && state.delivery !== 'confirmed')) return state;
    const physicalDirection = target.physicalDirection === 'source-reverse' ? 'source-forward' : 'source-reverse';
    const steps = state.steps.map((item, index) => index === targetIndex ? { ...item, physicalDirection } : item);
    const downstream = new Set(steps.slice(targetIndex).filter(item => item.kind !== 'output').map(item => item.runId));
    const confirmedRuns = Object.fromEntries(Object.entries(state.confirmedRuns).filter(([id]) => !downstream.has(id)));
    const corrections = [...state.corrections.filter(item => item.runId !== target.runId), { runId: target.runId, physicalDirection }];
    const next = { ...state, steps, stepIndex: targetIndex, confirmedRuns, corrections, delivery: 'idle', error: '', requestId: state.requestId + 1, firstPixelConfirmed: false };
    return { ...next, canComplete: completionTruth(next) };
  }
  if (action.type === 'complete' && state.canComplete) return { ...state, status: 'complete' };
  return state;
}

export function createWiringChaseSession({
  createStream = createCardFrameStream,
  priorLook = null,
  restoreLook = null,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let pending = null;
  let timer = null;
  let ended = false;
  let restoring = null;
  let refreshTimer = null;
  const finish = async () => {
    if (restoring) return restoring;
    restoring = (async () => {
      await stream.stop();
      if (refreshTimer != null) clearIntervalImpl(refreshTimer);
      refreshTimer = null;
      if (priorLook && typeof restoreLook === 'function') await restoreLook(priorLook);
    })();
    return restoring;
  };
  const fail = async error => {
    if (!pending) return;
    const reject = pending.reject;
    pending = null;
    if (timer != null) clearTimeoutImpl(timer);
    timer = null;
    ended = true;
    try { await finish(); } finally { reject(error); }
  };
  const stream = createStream({
    fps: CHASE_FPS,
    onHealth(health) {
      if (!pending || ended) return;
      if (health?.wsOpen === false || Number(health?.consecutiveFailures || 0) > 0) {
        const reason = health.reason === 'relay-socket-closed' || health?.wsOpen === false ? 'The card relay socket is closed.' : 'Frame delivery failed.';
        void fail(new Error(reason));
      } else if (health?.delivered === true && health?.ok !== false) {
        const resolve = pending.resolve;
        pending = null;
        if (timer != null) clearTimeoutImpl(timer);
        timer = null;
        resolve({ ok: true });
      }
    },
  });
  stream.start();
  return {
    show(frame) {
      if (ended) return Promise.reject(new Error('This chase session has ended.'));
      if (pending) return Promise.reject(new Error('A frame acknowledgement is already pending.'));
      if (timer != null) clearTimeoutImpl(timer);
      const promise = new Promise((resolve, reject) => { pending = { resolve, reject }; });
      timer = setTimeoutImpl(() => void fail(new Error('No frame acknowledgement within 1.5 seconds.')), CHASE_ACK_TIMEOUT_MS);
      if (refreshTimer != null) clearIntervalImpl(refreshTimer);
      stream.push(frame);
      refreshTimer = setIntervalImpl(() => stream.push(frame), Math.round(1000 / CHASE_FPS));
      return promise;
    },
    async stop() { ended = true; if (pending) { pending.reject(new Error('Chase cancelled.')); pending = null; } if (timer != null) clearTimeoutImpl(timer); timer = null; await finish(); },
    async complete() { await this.stop(); },
  };
}
