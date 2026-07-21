import React, { useEffect, useReducer, useRef, useState } from 'react';
import { ProductionRecovery } from './ProductionRecovery.jsx';
import { createCardFrameStream } from '../../lib/cardFrameStream.js';
import { readCardProjectEvidence } from '../../lib/cardPushClient.js';
import { invalidateCardLinkOperationLease } from '../../lib/cardLink.js';
import {
  activateAndWaitForCardWiring, confirmCardWiringCandidate, getCardWiringStatus,
  readCardWiringCandidateEvidence, rollbackCardWiringCandidate, stageCardWiringCandidate,
} from '../../lib/cardWiringSafety.js';
import {
  buildProductionBoundaryCandidate, buildProductionBoundaryFrame,
  buildProductionPhysicalResults,
  classifyProductionPhysicalObservation, createProductionKnownGood, createProductionKnownGoodFromConfig,
  createProductionPhysicalState, productionCorrectionAffectedBoundaryIds, productionPhysicalReducer,
  productionDiagnosticCurrentEstimate,
} from '../../lib/productionPhysicalTest.js';
import { classifyProductionPhysicalFailure } from '../../lib/productionRecovery.js';
import { readProductionPhysicalState, saveProductionPhysicalState } from '../../lib/productionPhysicalPersistence.js';
import { assignProductionWiringIdentity, productionWiringDigest } from '../../lib/productionWiringIdentity.js';
import {
  assertProductionCardLease,
  captureProductionCardLease,
  productionCardAuthority,
} from '../../lib/productionCardLease.js';

const FAILURES = [['nothing-lit', 'Nothing lit'], ['wrong-color', 'Colors wrong'], ['wrong-start-end', 'Blue / red swapped'], ['wrong-count', 'Red end is off'], ['wrong-output', 'Wrong strip lit'], ['flashing-or-frozen', 'Flashing or frozen']];
const COLOR_ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'];
const STREAM_RESULT = Object.freeze({ verified: 'verified', delivered: 'delivered', deliveryFailed: 'delivery-failed', identityBlocked: 'identity-blocked', firmwareBlocked: 'firmware-blocked', cancelled: 'cancelled' });
function productionDriver() { return import.meta.env.DEV ? window.__LW_PRODUCTION_DRIVER_FOR_TEST__ : null; }
function sameSegments(actual = [], expected = []) { return actual.length === expected.length && expected.every((segment, index) => actual[index]?.id === segment.id && Number(actual[index]?.count) === segment.count && (actual[index]?.direction || 'forward') === segment.direction); }
function sameOutputs(actual = [], expected = []) { return actual.length === expected.length && expected.every((output, index) => actual[index]?.id === output.id && Number(actual[index]?.pin) === output.pin && Number(actual[index]?.pixels) === output.pixels && sameSegments(actual[index]?.segments, output.segments)); }
function exactIdentity(value, job, cardId) { return value?.cardId === cardId && value?.firmwareVersion === job.firmware.version && value?.buildId === job.firmware.buildId && value?.projectRevision === job.project.revision && value?.projectFingerprint === job.project.fingerprint && value?.productionJobId === job.jobId && value?.productionJobDigest === job.digest; }
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function ProductionPhysicalTest({ job, runId, cardLink, expectedCardId, platform, onComplete, onResultsChange, onRecovery }) {
  const [knownGood, setKnownGood] = useState(() => createProductionKnownGood(job));
  const [state, dispatch] = useReducer(productionPhysicalReducer, knownGood, createProductionPhysicalState);
  const [route, setRoute] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [gpio, setGpio] = useState('');
  const [colorOrder, setColorOrder] = useState(knownGood.config.led.colorOrder);
  const [ready, setReady] = useState(false);
  const [failedObservation, setFailedObservation] = useState('');
  const [recoveryEntered, setRecoveryEntered] = useState(false);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const generationRef = useRef(0);
  const candidateOperationRef = useRef(0);
  const mountedRef = useRef(true);
  const tabRefs = useRef([]);
  const cardLinkRef = useRef(cardLink);
  const active = knownGood.boundaries.find(boundary => boundary.id === state.activeBoundaryId);
  const result = state.results[state.activeBoundaryId];
  const physicalRecovery = failedObservation && route ? classifyProductionPhysicalFailure(failedObservation) : null;

  cardLinkRef.current = cardLink;
  function currentCardLink() { return productionDriver()?.getCardLink?.() || cardLinkRef.current || {}; }
  function captureLease() { return captureProductionCardLease(currentCardLink(), expectedCardId, { mutation: 'runtime' }); }
  function assertLease(lease) { return assertProductionCardLease(lease, currentCardLink(), { mutation: 'runtime' }); }
  function invalidateLease(lease, reason = 'production-physical-operation-failed') { return invalidateCardLinkOperationLease(lease, { reason }); }
  async function reacquireAfterCardReboot(priorLease, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const next = captureLease();
        const changed = next.operationGeneration !== priorLease.operationGeneration
          || next.validatedBootId !== priorLease.validatedBootId
          || next.bridgeLifecycle !== priorLease.bridgeLifecycle;
        // The injected driver has no browser lifecycle; real production must
        // prove a changed/revalidated card generation after restart.
        if (changed || productionDriver()) return next;
      } catch { /* card is still restarting/revalidating */ }
      await wait(100);
    }
    throw new Error('The exact card did not revalidate after its wiring restart.');
  }

  useEffect(() => { setFailedObservation(''); setRecoveryEntered(false); }, [state.activeBoundaryId]);
  useEffect(() => { if (failedObservation) setRecoveryEntered(false); }, [failedObservation]);


  useEffect(() => { onResultsChange?.(state.results); }, [onResultsChange, state.results]);
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    (async () => {
      let lease = null;
      try {
        lease = captureLease();
        let status = await readWiringStatus(lease);
        assertLease(lease);
        if (!exactIdentity(status, job, expectedCardId)) throw new Error('Card wiring status does not belong to this exact card and job.');
        if (['staged', 'testing'].includes(status.state)) {
          if (!status.activationId) throw new Error('The card has temporary wiring without an activation identifier.');
          const driver = productionDriver();
          const rolledBack = driver?.rollbackCandidate ? await driver.rollbackCandidate(status.activationId) : await rollbackCardWiringCandidate(status.activationId, { host: lease.host, transport: lease.transport });
          if (rolledBack?.activationId && rolledBack.activationId !== status.activationId) throw new Error('Reload cleanup answered for another wiring candidate.');
          const rebootLease = await reacquireAfterCardReboot(lease);
          let rollbackReadError = null;
          for (let attempt = 0; attempt < 30; attempt += 1) {
            try {
              status = await readWiringStatus(rebootLease);
              assertLease(rebootLease);
              if (status?.state === 'known-good') { rollbackReadError = null; break; }
              rollbackReadError = new Error('Card is still restarting after rollback.');
            } catch (reason) { rollbackReadError = reason; }
            if (attempt < 29) await wait(400);
          }
          if (rollbackReadError) throw rollbackReadError;
        }
        if (status.state !== 'known-good') throw new Error('The card did not prove known-good wiring after reload cleanup.');
        const reconciled = await reconcileKnownGood(status);
        if (cancelled) return;
        setKnownGood(reconciled.snapshot);
        dispatch({ type: 'reset', source: reconciled.snapshot, results: reconciled.results });
        setReady(true);
      } catch (reason) {
        if (lease) invalidateLease(lease, 'production-wiring-readback-failed');
        if (!cancelled) {
          setError(`${reason?.message || reason} Restore the verified artwork and recheck every boundary.`);
          setRoute({ action: 'restore-project', title: 'Wiring truth could not be restored', guidance: 'No light frame was started. Restore this job before physical verification.' });
        }
      }
    })();
    return () => { cancelled = true; mountedRef.current = false; generationRef.current += 1; candidateOperationRef.current += 1; clearInterval(timerRef.current); void stopStream({ invalidate: false }); };
  }, [runId, job.digest, expectedCardId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return;
    const authority = productionCardAuthority(productionDriver()?.getCardLink?.() || cardLink || {}, expectedCardId, { mutation: 'runtime' });
    if (authority.ok) return;
    generationRef.current += 1;
    void stopStream({ invalidate: false });
    setReady(false);
    setError('Card link lost. The light test stopped immediately; reconnect and re-verify this exact card before continuing.');
    setRoute({ action: 'restore-project', title: 'Exact card link lost', guidance: 'No physical result or pass is authorized from the interrupted light test.' });
  }, [cardLink, expectedCardId, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready || !knownGood.wiringRevision || !knownGood.wiringDigest) return;
    try {
      saveProductionPhysicalState({
        runId, jobDigest: job.digest, cardId: expectedCardId,
        wiringRevision: knownGood.wiringRevision, wiringDigest: knownGood.wiringDigest,
        physicalConfig: { led: knownGood.config.led, zones: knownGood.config.zones || [] }, results: state.results,
      });
    } catch (reason) { setError(`Physical progress could not be saved safely: ${reason?.message || reason}`); }
  }, [ready, runId, job.digest, expectedCardId, knownGood, state.results]);

  useEffect(() => {
    if (!ready || state.candidate) return;
    setRoute(null); setError(''); setGpio(String(active?.pin ?? '')); setColorOrder(knownGood.config.led.colorOrder);
    void startStream(knownGood, active);
    return () => { generationRef.current += 1; void stopStream({ invalidate: false }); };
  }, [ready, state.activeBoundaryId, knownGood]); // eslint-disable-line react-hooks/exhaustive-deps

  async function stopStream({ invalidate = true } = {}) { if (invalidate) generationRef.current += 1; const stream = streamRef.current; streamRef.current = null; try { await stream?.stop?.(); } catch { /* recovery remains explicit */ } }
  async function readWiringStatus(lease = captureLease()) { const driver = productionDriver(); return driver?.readWiringStatus ? driver.readWiringStatus() : getCardWiringStatus({ host: lease.host, transport: lease.transport }); }
  async function reconcileKnownGood(status) {
    if (!Number.isSafeInteger(status.wiringRevision) || status.wiringRevision < 1 || !/^[a-f0-9]{64}$/.test(status.wiringDigest || '')
      || !Number.isSafeInteger(status.maxMilliamps) || status.maxMilliamps < 100 || status.maxMilliamps > 20000) throw new Error('Card read-back is missing persistent wiring/current evidence.');
    const baseline = createProductionKnownGood(job);
    const persisted = readProductionPhysicalState({ runId, jobDigest: job.digest, cardId: expectedCardId, wiringRevision: status.wiringRevision, wiringDigest: status.wiringDigest });
    const persistedConfig = persisted ? { ...baseline.config, ...persisted.physicalConfig, wiringRevision: status.wiringRevision, wiringDigest: status.wiringDigest } : null;
    if (persistedConfig && status.colorOrder === persistedConfig.led.colorOrder && status.maxMilliamps === persistedConfig.led.maxMilliamps && sameOutputs(status.outputs, persistedConfig.led.outputs)) {
      if (await productionWiringDigest(persistedConfig.led) !== status.wiringDigest) throw new Error('Saved physical wiring digest does not match the card.');
      return { snapshot: createProductionKnownGoodFromConfig(job, persistedConfig), results: persisted.results };
    }
    if (status.colorOrder === baseline.config.led.colorOrder && status.maxMilliamps === baseline.config.led.maxMilliamps && sameOutputs(status.outputs, baseline.config.led.outputs)
      && status.wiringRevision === baseline.config.wiringRevision && status.wiringDigest === baseline.config.wiringDigest) return { snapshot: baseline, results: {} };
    const countsMatch = status.outputs.length === baseline.config.led.outputs.length && baseline.config.led.outputs.every((output, index) => {
      const actual = status.outputs[index];
      return actual?.id === output.id && actual.pixels === output.pixels && sameSegments(actual.segments, output.segments.map((segment, segmentIndex) => ({ ...segment, direction: actual.segments?.[segmentIndex]?.direction || segment.direction })));
    });
    if (!countsMatch) throw new Error('Confirmed pixel counts changed but their saved zone mapping is unavailable.');
    const outputs = baseline.config.led.outputs.map((output, index) => {
      const actual = status.outputs[index];
      const directions = new Set(actual.segments.map(segment => segment.direction || 'forward'));
      return { ...output, pin: actual.pin, pixels: actual.pixels, segments: actual.segments, direction: directions.size === 1 ? [...directions][0] : 'mixed' };
    });
    const config = { ...baseline.config, wiringRevision: status.wiringRevision, wiringDigest: status.wiringDigest, led: { ...baseline.config.led, outputs, colorOrder: status.colorOrder, maxMilliamps: status.maxMilliamps } };
    if (await productionWiringDigest(config.led) !== status.wiringDigest) throw new Error('Card wiring digest does not match reconstructed physical wiring.');
    return { snapshot: createProductionKnownGoodFromConfig(job, config), results: {} };
  }
  async function handOffRecovery(action) {
    await stopStream();
    clearInterval(timerRef.current);
    setCountdown(0);
    await onRecovery?.(action);
  }
  function requireBoundaryRestart(title, guidance) {
    setFailedObservation('flashing-or-frozen');
    setRecoveryEntered(false);
    setRoute({ action: 'release-restart-stream', title, guidance });
  }
  function recordDeliveryFailure(boundaryId, generation, detail = '') {
    dispatch({ type: 'delivery-failed', boundaryId, generation });
    requireBoundaryRestart('Light test did not reach the LEDs', 'Release the failed light stream, then restart this boundary. Nothing can be confirmed until a fresh exact acknowledgement arrives.');
    if (detail) setError(`${detail} No light test was started.`);
  }
  async function handleStructuredRecovery(action) {
    if (action === 'retry-physical-stream') { await releaseAndRetry(); return; }
    if (action === 'open-physical-correction') {
      setRecoveryEntered(true);
      requestAnimationFrame(() => document.querySelector('.prod-diagnosis select, .prod-diagnosis input, .prod-diagnosis button')?.focus());
    }
  }
  async function readIdentity(lease) { const driver = productionDriver(); return driver?.readEvidence ? driver.readEvidence('physical') : readCardProjectEvidence({ host: lease.host, transport: lease.transport }); }
  async function verifyIdentity(lease) {
    assertLease(lease);
    const evidence = await readIdentity(lease);
    assertLease(lease);
    if (evidence?.firmwareVersion !== job.firmware.version || evidence?.buildId !== job.firmware.buildId) {
      invalidateLease(lease, 'production-physical-firmware-mismatch');
      setRoute(classifyProductionPhysicalObservation('flashing-or-frozen', { firmwareTrusted: false })); return STREAM_RESULT.firmwareBlocked;
    }
    if (!exactIdentity(evidence, job, expectedCardId)) {
      invalidateLease(lease, 'production-physical-identity-mismatch');
      setRoute(classifyProductionPhysicalObservation('nothing-lit', { cardIdentityMatches: false })); return STREAM_RESULT.identityBlocked;
    }
    return STREAM_RESULT.verified;
  }
  async function startStream(snapshot = knownGood, boundary = active) {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    await stopStream({ invalidate: false }); setError('');
    if (!boundary || generation !== generationRef.current || !mountedRef.current) return STREAM_RESULT.cancelled;
    dispatch({ type: 'delivery-started', boundaryId: boundary.id, generation });
    let lease = null;
    try {
      lease = captureLease();
      const identityResult = await verifyIdentity(lease);
      if (identityResult !== STREAM_RESULT.verified) return identityResult;
      if (generation !== generationRef.current || !mountedRef.current) return STREAM_RESULT.cancelled;
      const frame = buildProductionBoundaryFrame({ snapshot, boundaryId: boundary.id });
      const driver = productionDriver();
      if (driver?.startPhysical) {
        const response = await driver.startPhysical({ boundary, output: snapshot.config.led.outputs.find(output => output.id === boundary.outputId), frame, generation });
        assertLease(lease);
        if (generation !== generationRef.current || !mountedRef.current) return STREAM_RESULT.cancelled;
        const acknowledged = response?.ok !== false && response?.generation === generation;
        if (acknowledged) dispatch({ type: 'delivered', boundaryId: boundary.id, generation });
        else recordDeliveryFailure(boundary.id, generation);
        return acknowledged ? STREAM_RESULT.delivered : STREAM_RESULT.deliveryFailed;
      }
      const stream = createCardFrameStream({ host: lease.host, fps: 4, onHealth: health => {
        if (generation !== generationRef.current || !mountedRef.current) { void stream.stop(); return; }
        try { assertLease(lease); } catch (reason) {
          invalidateLease(lease, 'production-frame-lease-lost');
          recordDeliveryFailure(boundary.id, generation, reason.message);
          void stopStream();
          return;
        }
        if (health.delivered) dispatch({ type: 'delivered', boundaryId: boundary.id, generation });
        else { recordDeliveryFailure(boundary.id, generation); void stopStream(); }
      }, transport: lease.transport });
      if (generation !== generationRef.current || !mountedRef.current) { await stream.stop(); return STREAM_RESULT.cancelled; }
      streamRef.current = stream; stream.start(); stream.push(frame); return STREAM_RESULT.delivered;
    } catch (reason) {
      if (lease) invalidateLease(lease, 'production-frame-delivery-failed');
      if (generation === generationRef.current && mountedRef.current) recordDeliveryFailure(boundary.id, generation, reason?.message || String(reason));
      return STREAM_RESULT.deliveryFailed;
    }
  }

  async function readConfirmedKnownGood(snapshot) {
    const driver = productionDriver();
    const lease = captureLease();
    let lastReason = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const status = driver?.readWiringStatus ? await driver.readWiringStatus() : await getCardWiringStatus({ host: lease.host, transport: lease.transport });
        assertLease(lease);
        if (status?.state === 'known-good' && exactIdentity(status, job, expectedCardId) && status.colorOrder === snapshot.config.led.colorOrder
          && status.maxMilliamps === snapshot.config.led.maxMilliamps && status.wiringRevision === snapshot.wiringRevision
          && status.wiringDigest === snapshot.wiringDigest && sameOutputs(status.outputs, snapshot.config.led.outputs)) return status;
        lastReason = new Error('Card read-back is not the exact last confirmed wiring.');
      } catch (reason) { lastReason = reason; }
      if (attempt < 19) await wait(400);
    }
    throw lastReason || new Error('The card did not independently prove its last confirmed wiring.');
  }

  async function rollbackExactCandidate(candidate, snapshot = knownGood) {
    const driver = productionDriver();
    const lease = captureLease();
    const response = driver?.rollbackCandidate ? await driver.rollbackCandidate(candidate.activationId) : await rollbackCardWiringCandidate(candidate.activationId, { host: lease.host, transport: lease.transport });
    if (response?.activationId && response.activationId !== candidate.activationId) throw new Error('Rollback response belonged to another candidate.');
    await reacquireAfterCardReboot(lease);
    return readConfirmedKnownGood(snapshot);
  }

  async function observe(observation) {
    if (busy) return;
    try { assertLease(captureLease()); } catch (reason) { setError(reason.message); return; }
    setFailedObservation(observation === 'correct' ? '' : observation);
    setError(''); setRoute(classifyProductionPhysicalObservation(observation));
    if (observation !== 'correct') return;
    const candidate = state.candidate;
    if (candidate) {
      if (candidate.boundaryId !== state.activeBoundaryId) { setError('This candidate belongs to another boundary and cannot be confirmed here.'); return; }
      setBusy(true);
      let confirmLease = null;
      try {
        const lease = captureLease();
        confirmLease = lease;
        const driver = productionDriver();
        const confirmed = driver?.confirmCandidate ? await driver.confirmCandidate(candidate.activationId) : await confirmCardWiringCandidate(candidate.activationId, { host: lease.host, transport: lease.transport });
        assertLease(lease);
        if (confirmed?.state !== 'known-good' || (confirmed?.activationId && confirmed.activationId !== candidate.activationId)) throw new Error('The card did not confirm this exact candidate.');
        const readback = driver?.readWiringStatus ? await driver.readWiringStatus() : await getCardWiringStatus({ host: lease.host, transport: lease.transport });
        assertLease(lease);
        if (readback?.state !== 'known-good' || !exactIdentity(readback, job, expectedCardId) || readback.colorOrder !== candidate.config.led.colorOrder
          || readback.maxMilliamps !== candidate.config.led.maxMilliamps || readback.wiringRevision !== candidate.snapshot.wiringRevision
          || readback.wiringDigest !== candidate.snapshot.wiringDigest || !sameOutputs(readback.outputs, candidate.config.led.outputs)) throw new Error('Final card evidence did not match the exact confirmed candidate.');
        const invalidated = productionCorrectionAffectedBoundaryIds(knownGood, candidate.boundaryId, candidate.correction);
        setKnownGood(candidate.snapshot); dispatch({ type: 'candidate-confirmed', boundaryIds: invalidated }); clearInterval(timerRef.current); setCountdown(0);
      } catch (reason) { if (confirmLease) invalidateLease(confirmLease, 'production-wiring-confirm-failed'); setError(`${reason?.message || reason} The candidate remains temporary and will roll back.`); setBusy(false); return; }
      setBusy(false);
    }
    dispatch({ type: 'observe', boundaryId: state.activeBoundaryId, observation, activationId: candidate?.activationId });
  }

  async function applyCorrection(correction) {
    if (busy || state.candidate) return;
    setBusy(true); setError('');
    let stagedCandidate = null;
    let operationLease = null;
    const operation = candidateOperationRef.current + 1;
    candidateOperationRef.current = operation;
    const assertCandidateOperation = () => {
      if (!mountedRef.current || candidateOperationRef.current !== operation) throw new Error('The temporary wiring operation was cancelled.');
    };
    try {
      const lease = captureLease();
      operationLease = lease;
      if (await verifyIdentity(lease) !== STREAM_RESULT.verified) throw new Error('Card evidence changed before the candidate test.');
      const candidate = buildProductionBoundaryCandidate(knownGood, state.activeBoundaryId, correction);
      await assignProductionWiringIdentity(candidate.config, { revision: knownGood.wiringRevision + 1 });
      candidate.snapshot.wiringRevision = candidate.config.wiringRevision;
      candidate.snapshot.wiringDigest = candidate.config.wiringDigest;
      const driver = productionDriver();
      const staged = driver?.stageCandidate ? await driver.stageCandidate(candidate) : await stageCardWiringCandidate(candidate.config, { host: lease.host, transport: lease.transport });
      assertCandidateOperation();
      assertLease(lease);
      if (!staged?.activationId || staged.state !== 'staged') throw new Error('The card did not acknowledge a staged candidate.');
      stagedCandidate = { ...candidate, activationId: staged.activationId, phase: 'staged' };
      dispatch({ type: 'candidate', candidate: stagedCandidate });
      const evidence = driver?.readCandidateEvidence ? await driver.readCandidateEvidence(staged.activationId) : await readCardWiringCandidateEvidence(staged.activationId, { host: lease.host, transport: lease.transport });
      assertCandidateOperation();
      assertLease(lease);
      if (!exactIdentity(evidence, job, expectedCardId) || evidence.activationId !== staged.activationId || evidence.colorOrder !== candidate.config.led.colorOrder
        || evidence.maxMilliamps !== candidate.config.led.maxMilliamps || evidence.wiringRevision !== candidate.config.wiringRevision
        || evidence.wiringDigest !== candidate.config.wiringDigest || !sameOutputs(evidence.candidateOutputs, candidate.config.led.outputs)) throw new Error('Staged candidate evidence did not match this exact card, job, boundary, config, current cap, and wiring digest.');
      const testing = driver?.activateCandidate ? await driver.activateCandidate(staged.activationId) : await activateAndWaitForCardWiring(staged.activationId, { host: lease.host, transport: lease.transport });
      assertCandidateOperation();
      if (testing?.activationId !== staged.activationId || testing?.state !== 'testing') throw new Error('The exact candidate did not enter its 90-second test.');
      await reacquireAfterCardReboot(lease);
      const locked = { ...candidate, activationId: staged.activationId, phase: 'testing' };
      dispatch({ type: 'candidate', candidate: locked }); setCountdown(90); clearInterval(timerRef.current);
      timerRef.current = setInterval(() => setCountdown(value => {
        if (value <= 1) {
          clearInterval(timerRef.current);
          void stopStream();
          dispatch({ type: 'candidate-clear' });
          requireBoundaryRestart('Temporary change rolled back', 'The card restored the last confirmed wiring. Restart this boundary before making another observation.');
          return 0;
        }
        return value - 1;
      }), 1000);
      setRoute({ action: 'confirm-output', title: 'Temporary change is active', guidance: 'Only this boundary can be confirmed until the timer ends.' });
      const delivered = await startStream(candidate.snapshot, candidate.snapshot.boundaries.find(boundary => boundary.id === state.activeBoundaryId));
      if (delivered !== STREAM_RESULT.delivered) throw new Error('The candidate light frame did not reach this exact boundary.');
      setFailedObservation(''); setRecoveryEntered(false);
    } catch (reason) {
      if (stagedCandidate) {
        try {
          await rollbackExactCandidate(stagedCandidate, knownGood);
          dispatch({ type: 'candidate-clear' });
          requireBoundaryRestart('Temporary change was removed', 'The card independently proved the last confirmed wiring. Restart this boundary before making another observation.');
          setError(`${reason?.message || reason} The exact staged candidate was rolled back and the last confirmed wiring was read back.`);
        } catch (rollbackReason) {
          dispatch({ type: 'candidate', candidate: stagedCandidate });
          setRoute({ action: 'candidate-recovery', title: 'Temporary candidate is still locked', guidance: 'Studio could not prove rollback. Keep this boundary locked and use Restore last confirmed wiring again.' });
          setError(`${reason?.message || reason} Cleanup was not confirmed: ${rollbackReason?.message || rollbackReason}. Do not continue or disconnect this card.`);
        }
      } else { if (operationLease) invalidateLease(operationLease, 'production-wiring-candidate-failed'); setError(`${reason?.message || reason} The last confirmed wiring remains protected.`); }
    }
    finally { setBusy(false); }
  }

  async function rollback() {
    const candidate = state.candidate; if (!candidate || busy) return;
    setBusy(true); setError('');
    try {
      await rollbackExactCandidate(candidate, knownGood);
      dispatch({ type: 'candidate-clear' }); clearInterval(timerRef.current); setCountdown(0);
      requireBoundaryRestart('Last confirmed wiring restored', 'Restart this boundary to obtain a fresh exact frame acknowledgement before continuing.');
    } catch (reason) { setError(reason?.message || String(reason)); } finally { setBusy(false); }
  }
  async function releaseAndRetry() {
    setBusy(true);
    try {
      const result = await startStream();
      if (result === STREAM_RESULT.delivered) { setFailedObservation(''); setRecoveryEntered(false); setRoute(null); }
      else if (result === STREAM_RESULT.deliveryFailed) requireBoundaryRestart('Boundary restart did not complete', 'The new exact frame was not acknowledged. Keep this boundary locked and restart it again.');
      else if ([STREAM_RESULT.identityBlocked, STREAM_RESULT.firmwareBlocked].includes(result)) { setFailedObservation(''); setRecoveryEntered(false); }
    } finally { setBusy(false); }
  }
  async function completePhysical() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      assertLease(captureLease());
      await onComplete?.(buildProductionPhysicalResults(knownGood, state.results));
    } catch (reason) {
      if (mountedRef.current) setError(reason?.message || String(reason));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }
  const currentIndex = knownGood.boundaries.findIndex(boundary => boundary.id === active.id);
  const locked = Boolean(state.candidate);
  const deliveryConfirmed = ready && state.delivery === 'acknowledged' && state.deliveryBoundaryId === active.id;
  function handleTabKey(event, index) {
    if (locked || physicalRecovery || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const last = knownGood.boundaries.length - 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : event.key === 'ArrowRight' ? (index + 1) % knownGood.boundaries.length : (index - 1 + knownGood.boundaries.length) % knownGood.boundaries.length;
    dispatch({ type: 'select', boundaryId: knownGood.boundaries[next].id });
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }
  const currentEstimate = productionDiagnosticCurrentEstimate(buildProductionBoundaryFrame({ snapshot: knownGood, boundaryId: active.id }), knownGood.config.led.maxMilliamps);

  return <section className="prod-physical" aria-labelledby="prod-physical-title">
    <div className="prod-section-head"><div><span className="prod-kicker">Physical boundary · {currentIndex + 1} of {knownGood.boundaries.length}</span><h3 id="prod-physical-title">{active.label}</h3><small>{active.outputLabel} · capped at {currentEstimate.maxMilliamps} mA aggregate</small></div><span className="prod-card-id">GPIO {active.pin}</span></div>
    <p className="prod-physical-instruction"><span className="prod-marker blue" /> First pixel blue <span aria-hidden="true">·</span> <span className="prod-marker red" /> Pixel {active.count} red. Every other boundary stays dark.</p>
    <div className="prod-output-tabs" role="tablist" aria-label="Boundaries to test">{knownGood.boundaries.map((boundary, index) => <button ref={node => { tabRefs.current[index] = node; }} key={boundary.id} disabled={locked || !ready || Boolean(physicalRecovery)} type="button" role="tab" tabIndex={boundary.id === active.id ? 0 : -1} aria-selected={boundary.id === active.id} className={boundary.id === active.id ? 'selected' : ''} onKeyDown={event => handleTabKey(event, index)} onClick={() => dispatch({ type: 'select', boundaryId: boundary.id })}><span>{state.results[boundary.id]?.observation === 'correct' ? '✓' : index + 1}</span>{boundary.label}</button>)}</div>
    <div className={`prod-test-state ${state.delivery === 'failed' ? 'failed' : ''}`} role="status">{!ready ? 'Checking persistent wiring before starting any lights…' : state.delivery === 'acknowledged' ? 'Test delivered to this exact boundary. Look at the real LEDs — this is not a pass.' : state.delivery === 'failed' ? 'The test did not reach the LEDs.' : 'Starting a low-brightness test…'}</div>
    {physicalRecovery && !recoveryEntered && <ProductionRecovery
      recovery={physicalRecovery}
      phase="physical"
      firmwareTarget={`${job.firmware.target || 'esp32-s3-n16r8'}@${job.firmware.version}+${job.firmware.buildId.slice(0, 8)}`}
      platform={platform}
      onAction={action => void handleStructuredRecovery(action)}
    />}
    {route?.action === 'restore-project' || route?.action === 'signed-firmware-recovery' ? <div className="prod-diagnosis"><strong>{route.title}</strong><p>{route.guidance}</p><button type="button" onClick={() => void handOffRecovery(route.action)}>Stop test and continue safely</button></div> : <>
      {!physicalRecovery && (!result || result.observation !== 'correct') ? <><button className="btn primary prod-looks-right" type="button" disabled={busy || !deliveryConfirmed} onClick={() => void observe('correct')}>Yes, this boundary is correct</button><fieldset className="prod-observation"><legend>What do you see instead?</legend><div>{FAILURES.map(([id, label]) => <button type="button" key={id} disabled={busy || locked || !deliveryConfirmed} onClick={() => void observe(id)}>{label}</button>)}</div></fieldset></> : !physicalRecovery && <p className="prod-output-pass" role="status">✓ You physically confirmed this boundary.</p>}
      {physicalRecovery && recoveryEntered && route && !['confirm-output', 'restore-project', 'signed-firmware-recovery', 'inspect-power-data', 'release-restart-stream'].includes(route.action) && <div className="prod-diagnosis"><strong>{route.title}</strong><p>{route.guidance}</p>
        {route.action === 'adjust-count' && <div className="prod-inline-actions"><button type="button" disabled={busy || locked || !deliveryConfirmed} onClick={() => void applyCorrection({ kind: 'pixel-count', delta: -1 })}>− 1 pixel</button><button type="button" disabled={busy || locked || !deliveryConfirmed} onClick={() => void applyCorrection({ kind: 'pixel-count', delta: 1 })}>+ 1 pixel</button></div>}
        {route.action === 'test-direction' && <button type="button" disabled={busy || locked || !deliveryConfirmed} onClick={() => void applyCorrection({ kind: 'direction', direction: active.direction === 'reverse' ? 'forward' : 'reverse' })}>Try opposite direction</button>}
        {route.action === 'test-color-order' && <div className="prod-inline-actions"><label>Color order<select value={colorOrder} onChange={event => setColorOrder(event.target.value)}>{COLOR_ORDERS.map(order => <option key={order}>{order}</option>)}</select></label><button type="button" disabled={busy || locked || !deliveryConfirmed || colorOrder === knownGood.config.led.colorOrder} onClick={() => void applyCorrection({ kind: 'color-order', colorOrder })}>Test color order</button></div>}
        {route.action === 'test-gpio-output' && <div className="prod-inline-actions"><label>GPIO<input inputMode="numeric" value={gpio} onChange={event => setGpio(event.target.value)} /></label><button type="button" disabled={busy || locked || !deliveryConfirmed || Number(gpio) === active.pin} onClick={() => void applyCorrection({ kind: 'gpio', pin: Number(gpio) })}>Test GPIO</button></div>}
      </div>}
    </>}
    {state.candidate && <div className="prod-candidate" role="status"><strong>{state.candidate.phase === 'testing' ? `Temporary boundary test · ${countdown}s` : 'Temporary candidate cleanup required'}</strong><p>{active.label} is locked to activation {state.candidate.activationId}. It cannot be bypassed or confirmed from another boundary.</p><button type="button" disabled={busy} onClick={() => void rollback()}>Restore last confirmed wiring</button></div>}
    {error && <p className="prod-error" role="alert">{error}</p>}
    {state.canComplete && !physicalRecovery && <button className="btn primary" type="button" disabled={!deliveryConfirmed || busy} onClick={() => void completePhysical()}>Continue to pass record</button>}
  </section>;
}
