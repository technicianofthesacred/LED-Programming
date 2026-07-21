import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductionJobPicker } from '../components/production/ProductionJobPicker.jsx';
import { ProductionPassRecord } from '../components/production/ProductionPassRecord.jsx';
import { ProductionPhysicalTest } from '../components/production/ProductionPhysicalTest.jsx';
import { ProductionRecovery } from '../components/production/ProductionRecovery.jsx';
import { clearCardCommissioning } from '../lib/cardCommissioningFlow.js';
import { readCardProjectEvidence, readCardStatusEnvelope, pushConfigToCard } from '../lib/cardPushClient.js';
import { adoptExpectedCardIdentity } from '../lib/cardIdentity.js';
import { adoptCommissionedCardBridgeIdentity, getCardBridgeState, retargetCardBridge, sendCardBridgeRequest } from '../lib/cardBridge.js';
import { acceptWifiHandoff } from '../lib/cardWifiHandoff.js';
import { invalidateCardLinkOperationLease, reportDirectCardStatus, revalidateSharedCommissionedCard } from '../lib/cardLink.js';
import { getCardWiringStatus } from '../lib/cardWiringSafety.js';
import { connectESP, disconnectESP, flashFirmware, inspectConnectedESP } from '../lib/flash.js';
import { flashFirmwareAndRelease } from '../lib/flashWorkflow.js';
import { validateInstallHardware, validateProductionInstallRelease } from '../lib/flashPlan.js';
import { loadProductionFirmwareRelease } from '../lib/firmwareRelease.js';
import { detectPlatformCapabilities } from '../lib/platformCapabilities.js';
import { appendProductionRecord, readProductionRecords } from '../lib/productionRecords.js';
import { classifyProductionFailure, inferProductionFailure } from '../lib/productionRecovery.js';
import { assertProductionFinalWiringStatus } from '../lib/productionPhysicalTest.js';
import {
  assertProductionCardLease,
  captureProductionCardLease,
  productionCardAuthority,
} from '../lib/productionCardLease.js';
import {
  PRODUCTION_RUN_COMMIT_A_KEY, PRODUCTION_RUN_COMMIT_B_KEY,
  PRODUCTION_RUN_SLOT_A_KEY, PRODUCTION_RUN_SLOT_B_KEY,
  createProductionRun, readProductionRun, transitionProductionRun, updateProductionRunAtomically,
} from '../lib/productionRun.js';

const STEPS = [
  ['select-job', 'Job'], ['connect-card', 'USB card'], ['install', 'Firmware'],
  ['restore', 'Load artwork'], ['check-lights', 'Check lights'], ['complete', 'Record'],
];

function capabilities() {
  let topLevel = true;
  try { topLevel = window.self === window.top; } catch { topLevel = false; }
  return detectPlatformCapabilities({
    secureContext: window.isSecureContext,
    topLevel,
    serial: navigator.serial,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

function diagnosticPlatform(cap) {
  const architecture = String(navigator.userAgentData?.architecture || '').toLowerCase();
  const userAgent = String(navigator.userAgent || '').toLowerCase();
  const arch = /arm64|aarch64/.test(`${architecture} ${userAgent}`) ? 'arm64'
    : /\barm\b/.test(`${architecture} ${userAgent}`) ? 'arm'
      : /x86_64|x64|win64|amd64/.test(`${architecture} ${userAgent}`) ? 'x86_64'
        : /x86|win32/.test(`${architecture} ${userAgent}`) ? 'x86' : 'unknown';
  return { os: cap.platform === 'chromeos' ? 'chromeos' : cap.platform, arch };
}

function correlation(run) {
  return run && {
    runId: run.runId, flowId: run.flowId, jobDigest: run.jobDigest,
    operationId: run.operationId, expectedCardId: run.expectedCardId,
    generation: run.generation,
  };
}

function sameCorrelation(left, right) {
  return Boolean(left && right) && ['runId', 'flowId', 'jobDigest', 'operationId', 'expectedCardId', 'generation']
    .every(field => left[field] === right[field]);
}

function stageIndex(state) {
  const map = { 'select-job': 0, 'connect-card': 1, inspect: 1, install: 2, reconnect: 2, restore: 3, 'verify-card': 3, 'check-lights': 4, record: 5, complete: 5, recovery: 1 };
  return map[state] ?? 0;
}

function exactEvidence(evidence, job, cardId, release) {
  return evidence?.cardId === cardId
    && evidence?.firmwareVersion === release.manifest.firmwareVersion
    && evidence?.buildId === release.manifest.buildId
    && evidence?.projectRevision === job.project.revision
    && evidence?.projectFingerprint === job.project.fingerprint
    && evidence?.productionJobId === job.jobId
    && evidence?.productionJobDigest === job.digest;
}

export function ProductionScreen({ cardHost, cardLink, onConnectCard, embedded = false }) {
  const cap = useMemo(capabilities, []);
  const [job, setJob] = useState(null);
  const [run, setRun] = useState(() => readProductionRun());
  const [release, setRelease] = useState({ state: 'idle', value: null, error: '' });
  const [hardware, setHardware] = useState(null);
  const [usbConnected, setUsbConnected] = useState(false);
  const [usbOwnershipBlocked, setUsbOwnershipBlocked] = useState(false);
  const [firmwareDecision, setFirmwareDecision] = useState('uninspected');
  const [status, setStatus] = useState('Choose a verified artwork job to begin.');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [workerId, setWorkerId] = useState('');
  const [observations, setObservations] = useState({});
  const [recordRefresh, setRecordRefresh] = useState(0);
  const [recordRecoveryNeeded, setRecordRecoveryNeeded] = useState(false);
  const primaryRef = useRef(null);
  const actionRef = useRef(null);
  const loaderRef = useRef(null);
  const transportRef = useRef(null);
  const usbOwnershipRef = useRef({ connection: null, releasing: false, ownerRunId: '' });
  const restoreStartedRef = useRef(false);
  const savingPassRef = useRef(false);
  const previousStateRef = useRef(run?.state);
  const runRef = useRef(run);
  const mountedRef = useRef(true);
  const cardLinkRef = useRef(cardLink);
  const ProductionHeading = embedded ? 'h2' : 'h1';
  const ProductionLandmark = embedded ? 'section' : 'main';

  cardLinkRef.current = cardLink;
  runRef.current = run;

  function currentCardLink() {
    return testDriver()?.getCardLink?.() || cardLinkRef.current || {};
  }

  function authorityOptions(mutation = 'runtime') {
    if (!['config', 'runtime'].includes(mutation)) return { mutation };
    return {
      mutation,
      expectedFirmwareVersion: release.value?.manifest?.firmwareVersion || '',
      expectedBuildId: release.value?.manifest?.buildId || '',
    };
  }

  function captureCardLease(mutation = 'runtime', runLease = correlation(runRef.current)) {
    return captureProductionCardLease(currentCardLink(), runLease?.expectedCardId, authorityOptions(mutation));
  }

  function assertCardLease(lease, mutation = 'runtime') {
    return assertProductionCardLease(lease, currentCardLink(), authorityOptions(mutation));
  }

  function captureRunLease() {
    const lease = correlation(runRef.current);
    if (!lease) throw new Error('The production run is no longer active.');
    return Object.freeze(lease);
  }

  function assertRunLease(lease) {
    const current = readProductionRun();
    if (!sameCorrelation(lease, correlation(current))) {
      const error = new Error('The production run changed in another tab. This stale operation was cancelled.');
      error.code = 'stale-production-run';
      throw error;
    }
    return current;
  }

  function assertActiveRunLease(lease) {
    if (!mountedRef.current) {
      const error = new Error('The production screen closed. This stale operation was cancelled.');
      error.code = 'stale-production-run';
      throw error;
    }
    return assertRunLease(lease);
  }

  function runLeaseIsCurrent(lease) {
    return mountedRef.current && sameCorrelation(lease, correlation(runRef.current));
  }

  function invalidateOperation(lease, reason) {
    if (lease) invalidateCardLinkOperationLease(lease, { reason });
  }

  async function waitForRuntimeAuthority(expectedCardId, runLease, timeoutMs = 7000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertActiveRunLease(runLease);
      const authority = productionCardAuthority(currentCardLink(), expectedCardId, authorityOptions('runtime'));
      if (authority.ok) return captureProductionCardLease(currentCardLink(), expectedCardId, authorityOptions('runtime'));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The configured card did not establish two fresh command-ready status checks.');
  }

  async function adoptVerifiedBridgeIdentity(flowId, lease, mutation, timeoutMs = 7000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      assertCardLease(lease, mutation);
      const bridge = getCardBridgeState();
      if (bridge.lifecycle !== lease.bridgeLifecycle || bridge.handoffFlowId !== flowId) {
        throw new Error('The card page lifecycle changed before verified production pairing completed.');
      }
      try {
        const adopted = adoptCommissionedCardBridgeIdentity(flowId);
        if (adopted?.id === lease.expectedCardId) return adopted;
      } catch (reason) { lastError = reason; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw lastError || new Error('The configured bridge did not become ready for exact production pairing.');
  }

  const displayedCardLink = testDriver()?.getCardLink?.() || cardLink || {};
  const configAuthority = productionCardAuthority(displayedCardLink, run?.expectedCardId, authorityOptions('config'));
  const runtimeAuthority = productionCardAuthority(displayedCardLink, run?.expectedCardId, authorityOptions('runtime'));
  const readbackAuthority = productionCardAuthority(displayedCardLink, run?.expectedCardId, { mutation: 'readback' });

  const advance = useCallback(async (next, options = {}, origin) => {
    const expected = origin || correlation(runRef.current);
    if (!expected) throw new Error('The production run is no longer active.');
    const updated = await updateProductionRunAtomically(current => transitionProductionRun(current, next, { correlation: expected, ...options }));
    runRef.current = updated;
    if (mountedRef.current) setRun(updated);
    return updated;
  }, []);

  const showRecovery = useCallback((kind, context = {}) => {
    const next = typeof kind === 'string'
      ? classifyProductionFailure(kind, context)
      : inferProductionFailure(kind, { os: cap.platform, ...context });
    setError('');
    setRecovery(next);
    return next;
  }, [cap.platform]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; void disconnectESP(loaderRef.current, transportRef.current); };
  }, []);
  useEffect(() => {
    const syncStoredRun = event => {
      if (event?.key && ![PRODUCTION_RUN_COMMIT_A_KEY, PRODUCTION_RUN_COMMIT_B_KEY, PRODUCTION_RUN_SLOT_A_KEY, PRODUCTION_RUN_SLOT_B_KEY].includes(event.key)) return;
      const stored = readProductionRun();
      if (sameCorrelation(correlation(runRef.current), correlation(stored))) return;
      runRef.current = stored;
      restoreStartedRef.current = false;
      savingPassRef.current = false;
      setBusy(false);
      setRecovery(null);
      setRun(stored);
      setStatus('Production run changed in another tab. Any operation from this tab was cancelled.');
    };
    window.addEventListener('storage', syncStoredRun);
    return () => window.removeEventListener('storage', syncStoredRun);
  }, []);
  useEffect(() => { if (!embedded) primaryRef.current?.focus(); }, [embedded]);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = run?.state;
    if (!run?.state || previous === run.state || !job) return;
    requestAnimationFrame(() => actionRef.current?.querySelector('.btn.primary:not([disabled]), input:not([disabled]), button:not([disabled])')?.focus());
  }, [job, run?.state]);
  useEffect(() => {
    if (release.state !== 'ready' || !job) return;
    requestAnimationFrame(() => actionRef.current?.querySelector('.btn.primary:not([disabled])')?.focus());
  }, [job, release.state]);
  useEffect(() => {
    if (!run?.expectedCardId || !['restore', 'verify-card', 'check-lights', 'record'].includes(run.state)) return;
    const observed = testDriver()?.getCardLink?.() || cardLink || {};
    const mutation = run.state === 'restore' ? 'config' : 'runtime';
    const authority = run.state === 'verify-card'
      ? (productionCardAuthority(observed, run.expectedCardId, authorityOptions('runtime')).ok
        ? { ok: true }
        : productionCardAuthority(observed, run.expectedCardId, { mutation: 'readback' }))
      : productionCardAuthority(observed, run.expectedCardId, authorityOptions(mutation));
    if (!authority.ok) {
      setStatus('Card link lost — reconnect the exact USB-inspected card. No command or pass is authorized.');
    }
  }, [cardLink, run?.expectedCardId, run?.state]);

  async function preloadFirmware(selected = job) {
    if (!selected || release.state === 'loading') return;
    setRelease({ state: 'loading', value: null, error: '' });
    setError('');
    try {
      const value = await loadProductionFirmwareRelease();
      validateProductionInstallRelease(value);
      if (value.manifest.firmwareVersion !== selected.firmware.version || value.manifest.buildId !== selected.firmware.buildId) {
        throw new Error(`This job requires official firmware ${selected.firmware.version} (${selected.firmware.buildId.slice(0, 8)}), but the published release is different.`);
      }
      setRelease({ state: 'ready', value, error: '' });
      setRecovery(null);
      setStatus('Job and official firmware are verified and held on this computer. You can connect the USB card.');
    } catch {
      setRelease({ state: 'error', value: null, error: '' });
      showRecovery('signed-release-failure');
    }
  }

  async function selectJob(selected) {
    setError(''); setRecovery(null);
    let preparedRun;
    let preparedStatus;
    try {
      const saved = readProductionRun();
      if (saved && saved.jobDigest === selected.digest && saved.state !== 'complete') {
        if (saved.state === 'install') {
          preparedRun = await updateProductionRunAtomically(current => {
            const recovery = transitionProductionRun(current, 'recovery', { correlation: correlation(current), recoveryAction: 'release-usb', usbReleased: false });
            return transitionProductionRun(recovery, 'connect-card', { correlation: correlation(recovery), usbReleased: false });
          });
          preparedStatus = 'A previous installation was interrupted. USB is not reused automatically; reconnect and inspect the same card before deciding what it needs.';
        } else {
          preparedRun = saved;
          preparedStatus = saved.state === 'reconnect' ? 'Installation was interrupted at reconnect. Reconnect the same card; firmware will not install again.' : `Resuming this job at ${saved.state.replaceAll('-', ' ')}.`;
        }
      } else {
        preparedRun = await updateProductionRunAtomically(() => {
          const created = createProductionRun({ jobDigest: selected.digest });
          return transitionProductionRun(created, 'connect-card', { correlation: correlation(created) });
        });
        preparedStatus = 'Job verified. Studio is now verifying the official firmware before USB is requested.';
      }
    } catch (reason) {
      throw new Error(`This job could not start because workshop progress could not be saved. Nothing changed. ${reason?.message || String(reason)}`);
    }

    setJob(selected); setRun(preparedRun); setStatus(preparedStatus);
    setHardware(null); setUsbConnected(false); setFirmwareDecision('uninspected'); setObservations({}); setRecordRecoveryNeeded(false); restoreStartedRef.current = false;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (!(hash.get('screen') === 'card' && hash.get('section') === 'workshop')) hash.set('screen', 'production');
    hash.set('job', selected.jobId);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    await preloadFirmware(selected);
  }

  function testDriver() {
    return import.meta.env.DEV ? window.__LW_PRODUCTION_DRIVER_FOR_TEST__ : null;
  }

  function retainUsbOwnership(connection, releasing = false) {
    if (!connection) return;
    const retained = usbOwnershipRef.current;
    usbOwnershipRef.current = {
      connection,
      releasing,
      ownerRunId: retained.connection === connection ? retained.ownerRunId : String(runRef.current?.runId || ''),
    };
    setUsbOwnershipBlocked(true);
  }

  function clearUsbOwnership(connection) {
    if (usbOwnershipRef.current.connection !== connection) return;
    usbOwnershipRef.current = { connection: null, releasing: false, ownerRunId: '' };
    setUsbOwnershipBlocked(false);
  }

  async function releaseUsbConnection(requestedConnection = null) {
    const connection = requestedConnection || usbOwnershipRef.current.connection
      || (loaderRef.current || transportRef.current ? { loader: loaderRef.current, transport: transportRef.current } : null);
    if (!connection) return true;
    if (!connection?.loader && !connection?.transport && !testDriver()) return true;
    // This barrier is deliberately independent of a production-run lease. A
    // storage event may replace the run while the physical port is releasing.
    retainUsbOwnership(connection, true);
    try {
      const result = testDriver()?.disconnect
        ? await testDriver().disconnect(connection)
        : await disconnectESP(connection?.loader, connection?.transport);
      const released = result !== false;
      if (released) clearUsbOwnership(connection);
      else retainUsbOwnership(connection, false);
      return released;
    } catch {
      retainUsbOwnership(connection, false);
      return false;
    }
  }

  async function persistUsbOwnershipForCurrentRun({ released }) {
    try {
      const updated = await updateProductionRunAtomically(currentRun => {
        const currentLease = correlation(currentRun);
        const recoveryRun = transitionProductionRun(currentRun, 'recovery', {
          correlation: currentLease, recoveryAction: 'release-usb', usbReleased: released,
        });
        return transitionProductionRun(recoveryRun, 'connect-card', {
          correlation: correlation(recoveryRun), usbReleased: released,
        });
      });
      runRef.current = updated;
      if (mountedRef.current) setRun(updated);
      return updated;
    } catch { return null; }
  }

  async function persistUnreleasedUsb(origin) {
    try {
      const updated = await updateProductionRunAtomically(currentRun => {
        const typed = transitionProductionRun(currentRun, 'recovery', { correlation: origin, recoveryAction: 'release-usb', usbReleased: false });
        return transitionProductionRun(typed, 'connect-card', { correlation: correlation(typed), usbReleased: false });
      });
      runRef.current = updated;
      setRun(updated);
      return updated;
    } catch { return null; /* the visible recovery remains conservative even if persistence is unavailable */ }
  }

  async function releaseRetainedUsbOwnership() {
    if (busy || !usbOwnershipRef.current.connection) return;
    const startingRunId = runRef.current?.runId;
    const connection = usbOwnershipRef.current.connection;
    setBusy(true);
    try {
      const released = await releaseUsbConnection(connection);
      const updated = await persistUsbOwnershipForCurrentRun({ released });
      if (!released) return;
      if (loaderRef.current === connection.loader) loaderRef.current = null;
      if (transportRef.current === connection.transport) transportRef.current = null;
      if (updated?.runId === startingRunId) {
        setUsbConnected(false);
        setHardware(null);
        setRecovery(null);
        setStatus('USB release is confirmed. Connect one card to continue.');
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function connectCard() {
    const retained = usbOwnershipRef.current;
    const foreignUsbOwnership = Boolean(retained.connection
      && (retained.ownerRunId !== runRef.current?.runId || runRef.current?.usbReleased === false));
    if (busy || release.state !== 'ready' || foreignUsbOwnership) return;
    const runLease = captureRunLease();
    let activeRunLease = runLease;
    setBusy(true); setError(''); setRecovery(null); setStatus('Select the one Lightweaver card connected by USB.');
    let connection = null;
    try {
      const driver = testDriver();
      connection = driver?.connectCard ? await driver.connectCard() : await connectESP();
      retainUsbOwnership(connection);
      assertActiveRunLease(runLease);
      const rawInspection = driver?.inspectCard ? await driver.inspectCard(connection) : await inspectConnectedESP(connection.loader, connection.chip);
      assertActiveRunLease(runLease);
      const inspected = { ...rawInspection, ...validateInstallHardware(rawInspection) };
      if (runLease.expectedCardId && inspected.cardId !== runLease.expectedCardId) {
        throw new Error(`Wrong card. Reconnect ${runLease.expectedCardId}; this card is ${inspected.cardId}. Nothing was changed.`);
      }
      loaderRef.current = connection.loader;
      transportRef.current = connection.transport;
      // Selecting a physical USB card is the production-line pairing gesture.
      // Replace any prior gallery card only with this hardware-proven identity;
      // LAN status still has to independently prove the same id before use.
      adoptExpectedCardIdentity({ id: inspected.cardId });
      setUsbConnected(true);
      setHardware(inspected);
      setRecovery(null);
      if (runRef.current?.state === 'connect-card') {
        const inspectedRun = await advance('inspect', { expectedCardId: inspected.cardId }, runLease);
        activeRunLease = Object.freeze(correlation(inspectedRun));
        assertActiveRunLease(activeRunLease);
      }
      setStatus(`Card ${inspected.cardId} inspected. Nothing has been changed.`);
    } catch (reason) {
      const acquired = Boolean(connection);
      const released = acquired ? await releaseUsbConnection(connection) : true;
      const operationWasCurrent = runLeaseIsCurrent(activeRunLease);
      if (!released) {
        const ownershipRun = await persistUsbOwnershipForCurrentRun({ released: false });
        if (operationWasCurrent && ownershipRun) activeRunLease = Object.freeze(correlation(ownershipRun));
      }
      if (reason?.code === 'stale-production-run' || !operationWasCurrent) return;
      loaderRef.current = released ? null : connection?.loader || null;
      transportRef.current = released ? null : connection?.transport || null;
      setUsbConnected(!released); setHardware(null);
      if (!runLeaseIsCurrent(activeRunLease)) return;
      showRecovery(reason, { phase: run?.state || 'connect-card', cardChanged: 'no', usbReleased: released ? 'yes' : 'unknown' });
    }
    finally { if (runLeaseIsCurrent(activeRunLease)) setBusy(false); }
  }

  async function inspectInstalledFirmware() {
    if (busy || !hardware || !usbConnected || run.state !== 'inspect') return;
    const runLease = captureRunLease();
    let activeRunLease = runLease;
    setBusy(true); setError('');
    try {
      const connection = usbOwnershipRef.current.connection || { loader: loaderRef.current, transport: transportRef.current };
      const released = await releaseUsbConnection(connection);
      const operationWasCurrent = runLeaseIsCurrent(runLease);
      if (!released) {
        const ownershipRun = await persistUsbOwnershipForCurrentRun({ released: false });
        if (operationWasCurrent && ownershipRun) activeRunLease = Object.freeze(correlation(ownershipRun));
      }
      if (!operationWasCurrent) return;
      assertActiveRunLease(activeRunLease);
      if (released) { loaderRef.current = null; transportRef.current = null; setUsbConnected(false); }
      if (!released) throw new Error('USB ownership could not be released.');
      activeRunLease = await readInstalledFirmwareEvidence(runLease) || runLease;
    } catch (reason) {
      if (reason?.code === 'stale-production-run' || !runLeaseIsCurrent(runLease)) return;
      setFirmwareDecision('unproven');
      showRecovery('usb-ownership-uncertain');
    } finally { if (runLeaseIsCurrent(activeRunLease)) setBusy(false); }
  }

  async function connectCardPageThroughWifi(runLease, initialHost, { authority = 'identity' } = {}) {
    await onConnectCard?.(initialHost);
    assertActiveRunLease(runLease);
    if (window.location.protocol !== 'https:') return;

    setStatus('Finish WiFi setup in the card page. Studio is waiting for this exact card to join the gallery network.');
    const setupDeadline = Date.now() + 180000;
    let handoff = null;
    let finalStationSeen = false;
    while (Date.now() < setupDeadline && !handoff && !finalStationSeen) {
      assertActiveRunLease(runLease);
      try {
        const apStatus = await sendCardBridgeRequest('status', { cache: 'no-store', nonce: Date.now() }, {
          host: initialHost, timeoutMs: 1500, retryOnTimeout: false,
        });
        assertActiveRunLease(runLease);
        finalStationSeen = apStatus?.wifi?.transport === 'station'
          && apStatus?.wifi?.transition === 'station'
          && apStatus?.wifi?.transitionPending === false;
        if (!finalStationSeen) {
          const generation = Number(apStatus?.wifi?.handoffGeneration);
          handoff = acceptWifiHandoff({
            status: apStatus,
            expectedCard: {
              id: runLease.expectedCardId,
              firmwareVersion: release.value.manifest.firmwareVersion,
              buildId: release.value.manifest.buildId,
            },
            expectedBootId: apStatus?.bootId,
            lastGeneration: Number.isSafeInteger(generation) && generation > 0 ? generation - 1 : 0,
          });
        }
      } catch (reason) {
        if (reason?.code === 'stale-production-run') throw reason;
        // The card may be switching radios; keep the bounded setup wait
        // attached to this immutable production run and exact host.
      }
      if (!handoff && !finalStationSeen) {
        await new Promise(resolve => setTimeout(resolve, 750));
        assertActiveRunLease(runLease);
      }
    }
    assertActiveRunLease(runLease);
    if (!handoff && !finalStationSeen) throw new Error('The exact card did not complete WiFi setup before the bounded setup wait ended.');

    if (handoff) {
      assertActiveRunLease(runLease);
      const retargeted = retargetCardBridge(handoff.host, handoff, { flowId: runLease.flowId });
      if (!retargeted.ok) throw new Error('The verified card page could not move from its setup hotspot to the gallery network.');
      setStatus('Card joined WiFi. Rejoin the gallery network; Studio will continue automatically when the exact card returns.');
    }

    const returnDeadline = Date.now() + 180000;
    while (Date.now() < returnDeadline) {
      assertActiveRunLease(runLease);
      if (productionCardAuthority(currentCardLink(), runLease.expectedCardId, authorityOptions(authority)).ok) return;
      await new Promise(resolve => setTimeout(resolve, 100));
      assertActiveRunLease(runLease);
    }
    throw new Error('The exact card did not return on the gallery network before setup timed out.');
  }

  async function readInstalledFirmwareEvidence(runLease = captureRunLease()) {
    let activeRunLease = runLease;
    let lease = null;
    try {
      const driver = testDriver();
      // Opening/reconnecting the local card page is the required HTTPS → local
      // handoff. The verified job and firmware remain resident in this screen.
      if (driver?.connectLan) {
        await driver.connectLan();
        assertActiveRunLease(runLease);
      } else await connectCardPageThroughWifi(runLease, cardHost);
      assertActiveRunLease(runLease);
      driver?.noteLanHandoff?.();
      lease = captureCardLease('identity', runLease);
      const evidence = driver?.readEvidence ? await driver.readEvidence('preflight') : await readCardProjectEvidence({ host: lease.host, transport: lease.transport });
      assertCardLease(lease, 'identity');
      assertRunLease(runLease);
      if (!evidence?.cardId) throw new Error('The card page did not return card identity.');
      if (evidence.cardId !== runLease.expectedCardId) {
        throw new Error(`Wrong online card. USB identified ${runLease.expectedCardId}, but the card page reports ${evidence.cardId}. Nothing was changed.`);
      }
      const exact = evidence.firmwareVersion === release.value.manifest.firmwareVersion && evidence.buildId === release.value.manifest.buildId;
      if (exact) {
        setRecovery(null);
        setFirmwareDecision('exact');
        const restoringRun = await advance('restore', { usbReleased: true }, runLease);
        activeRunLease = Object.freeze(correlation(restoringRun));
        assertActiveRunLease(activeRunLease);
        setStatus('The online card is the same USB card and already has the exact official firmware. Ready to load the artwork.');
      } else {
        setFirmwareDecision('install-required');
        setHardware(null);
        setStatus(`Card ${evidence.cardId} reports firmware ${evidence.firmwareVersion} (${evidence.buildId.slice(0, 8)}), which does not match the verified release. Reconnect the same USB card to update it.`);
      }
      return activeRunLease;
    } catch (reason) {
      if (reason?.code === 'stale-production-run' || !runLeaseIsCurrent(activeRunLease)) return null;
      if (lease && reason?.code !== 'stale-production-run') invalidateOperation(lease, 'production-preflight-failed');
      setFirmwareDecision('unproven');
      if (/wrong online card/i.test(String(reason?.message || ''))) showRecovery('wrong-card-reconnect');
      else showRecovery('card-page-unavailable');
      return activeRunLease;
    }
  }

  async function retryInstalledFirmwareEvidence() {
    if (busy || run.state !== 'inspect') return;
    const runLease = captureRunLease();
    let activeRunLease = runLease;
    setBusy(true); setError('');
    try { activeRunLease = await readInstalledFirmwareEvidence(runLease) || runLease; }
    finally { if (runLeaseIsCurrent(activeRunLease)) setBusy(false); }
  }

  async function installOrContinue() {
    if (busy || !hardware || release.state !== 'ready') return;
    const retained = usbOwnershipRef.current;
    if (retained.connection && (retained.ownerRunId !== runRef.current?.runId || runRef.current?.usbReleased === false)) return;
    if (firmwareDecision !== 'install-required' || !usbConnected) return;
    setBusy(true); setError('');
    const runLease = captureRunLease();
    const installConnection = usbOwnershipRef.current.connection || { loader: loaderRef.current, transport: transportRef.current };
    let activeRunLease = runLease;
    let installLease = null;
    let installReleaseAttempted = false;
    let installReleasedByFlow = false;
    try {
      const installingRun = await advance('install', { cardChanged: false, usbReleased: false }, runLease);
      installLease = Object.freeze(correlation(installingRun));
      activeRunLease = installLease;
        const driver = testDriver();
        if (driver?.install) {
          await driver.install({ release: release.value, hardware, onProgress: setProgress });
          assertActiveRunLease(installLease);
          installReleaseAttempted = true;
          if (!await releaseUsbConnection(installConnection)) {
            throw new Error('USB release could not be confirmed after firmware installation.');
          }
          installReleasedByFlow = true;
        }
        else {
          const file = new File([release.value.bytes], `lightweaver-${release.value.manifest.firmwareVersion}.bin`, { type: 'application/octet-stream' });
          await flashFirmwareAndRelease({
            loader: loaderRef.current, transport: transportRef.current, file, address: 0, eraseAll: true, flashFirmware, onProgress: setProgress,
            disconnectESP: async (loader, transport) => {
              if (!await disconnectESP(loader, transport)) throw new Error('USB release could not be confirmed after firmware installation.');
            },
          });
          clearUsbOwnership(installConnection);
          installReleasedByFlow = true;
        }
        assertActiveRunLease(installLease);
        loaderRef.current = null; transportRef.current = null;
        setUsbConnected(false);
        const reconnectingRun = await advance('reconnect', { cardChanged: true, usbReleased: true }, installLease);
        installLease = Object.freeze(correlation(reconnectingRun));
        activeRunLease = installLease;
        assertActiveRunLease(installLease);
        setStatus('Official firmware installed and USB released. Reconnect the same card after it restarts; Studio will not install it again.');
    } catch (reason) {
      const released = installReleasedByFlow ? true
        : installReleaseAttempted ? false
          : await releaseUsbConnection(installConnection);
      const catchLease = activeRunLease;
      const operationWasCurrent = runLeaseIsCurrent(catchLease);
      if (!released) {
        const ownershipRun = await persistUsbOwnershipForCurrentRun({ released: false });
        if (operationWasCurrent && ownershipRun) activeRunLease = Object.freeze(correlation(ownershipRun));
      }
      if (reason?.code === 'stale-production-run' || !operationWasCurrent) return;
      if (released) { loaderRef.current = null; transportRef.current = null; setUsbConnected(false); }
      else setUsbConnected(true);
      setHardware(null);
      try {
        if (installLease) {
          const recoveryRun = await advance('recovery', { recoveryAction: 'release-usb', cardChanged: true, usbReleased: released }, installLease);
          activeRunLease = Object.freeze(correlation(recoveryRun));
          const connectingRun = await advance('connect-card', { cardChanged: true, usbReleased: released }, correlation(recoveryRun));
          activeRunLease = Object.freeze(correlation(connectingRun));
        }
      } catch {}
      if (!runLeaseIsCurrent(activeRunLease)) return;
      showRecovery(released ? 'disconnect-phase' : 'usb-ownership-uncertain', { cardChanged: 'unknown', usbReleased: released ? 'yes' : 'unknown' });
    }
    finally { if (runLeaseIsCurrent(activeRunLease)) setBusy(false); }
  }

  async function reconnectAfterInstall() {
    setBusy(true); setError('');
    const runLease = captureRunLease();
    let activeRunLease = runLease;
    let lease = null;
    try {
      const driver = testDriver();
      if (!driver?.readEvidence) await connectCardPageThroughWifi(runLease, '192.168.4.1', { authority: 'config' });
      assertActiveRunLease(runLease);
      lease = captureCardLease('config', runLease);
      const evidence = driver?.readEvidence ? await driver.readEvidence('reconnect') : await readCardProjectEvidence({ host: lease.host, transport: lease.transport });
      assertCardLease(lease, 'config');
      assertActiveRunLease(runLease);
      if (evidence.cardId !== runLease.expectedCardId) throw new Error(`Wrong card. Reconnect ${runLease.expectedCardId}; the online card is ${evidence.cardId}.`);
      if (evidence.firmwareVersion !== release.value.manifest.firmwareVersion || evidence.buildId !== release.value.manifest.buildId) {
        showRecovery('firmware-mismatch', { cardChanged: run?.cardChanged ? 'yes' : 'no', firmwareEvidence: {
          exactCard: true, installedVersion: evidence.firmwareVersion, installedBuildId: evidence.buildId,
          targetVersion: release.value.manifest.firmwareVersion, targetBuildId: release.value.manifest.buildId,
        } });
        return;
      }
      const restoringRun = await advance('restore', { usbReleased: true }, runLease);
      activeRunLease = Object.freeze(correlation(restoringRun));
      assertActiveRunLease(activeRunLease);
      setStatus('The same card is online with the exact firmware. Ready to load the artwork once.');
    } catch (reason) {
      if (reason?.code === 'stale-production-run' || !runLeaseIsCurrent(activeRunLease)) return;
      if (lease && reason?.code !== 'stale-production-run') invalidateOperation(lease, 'production-reconnect-readback-failed');
      showRecovery(reason, { phase: 'reconnect', usbReleased: 'yes' });
    }
    finally { if (runLeaseIsCurrent(activeRunLease)) setBusy(false); }
  }

  async function restoreArtwork() {
    if (busy || restoreStartedRef.current || run.state !== 'restore') return;
    restoreStartedRef.current = true; setBusy(true); setError('');
    const runLease = captureRunLease();
    let mutationRunLease = runLease;
    let lease = null;
    let mutationIntentPersisted = false;
    try {
      assertActiveRunLease(runLease);
      const driver = testDriver();
      lease = captureCardLease('config', runLease);
      const blankConfig = productionCardAuthority(currentCardLink(), runLease.expectedCardId, authorityOptions('config')).blank === true;
      const binding = driver?.readEvidence ? await driver.readEvidence('before-restore') : await readCardProjectEvidence({ host: lease.host, transport: lease.transport });
      assertCardLease(lease, 'config');
      assertActiveRunLease(runLease);
      if (binding.cardId !== runLease.expectedCardId
        || binding.firmwareVersion !== release.value.manifest.firmwareVersion
        || binding.buildId !== release.value.manifest.buildId) {
        throw new Error('The online card is no longer the exact USB-inspected card and firmware. Nothing was restored.');
      }
      // Commit the one-time mutation intention before the POST. A crash after
      // this point resumes at independent read-back and can never replay the
      // restore automatically.
      const verifyingRun = await advance('verify-card', { usbReleased: true }, runLease);
      mutationRunLease = Object.freeze(correlation(verifyingRun));
      mutationIntentPersisted = true;
      if (driver?.restore) await driver.restore(job.configuration);
      else await pushConfigToCard(job.configuration, {
        host: lease.host,
        transport: lease.transport,
        autoDiscover: false,
        reboot: 'if-needed',
        allowProjectChange: true,
        allowLayoutChange: true,
        commissioningFlowId: lease.commissioningFlowId,
          factoryBlank: blankConfig,
        });
      assertActiveRunLease(mutationRunLease);
      // Applying first wiring may restart the card or replace the bridge page.
      // The old lease is expected to die. The next step uses a new, exact
      // handoff/readback lease and will not replay this mutation.
      setStatus('Artwork was sent once. Now Studio will rebind the exact card lifecycle and read it back independently.');
    } catch (reason) {
      const catchRunLease = mutationIntentPersisted ? mutationRunLease : runLease;
      if (reason?.code === 'stale-production-run' || !runLeaseIsCurrent(catchRunLease)) return;
      if (lease && reason?.code !== 'stale-production-run') invalidateOperation(lease, 'production-config-failed');
      if (!mutationIntentPersisted) restoreStartedRef.current = false;
      if (mutationIntentPersisted) {
        showRecovery('restore-failure', { cardChanged: 'unknown', usbReleased: 'yes' });
        if (/card link/i.test(String(reason?.message || ''))) setError(reason.message);
      }
      else showRecovery(/exact USB-inspected card/i.test(String(reason?.message || '')) ? 'wrong-card-reconnect' : 'restore-failure', { cardChanged: 'no', usbReleased: 'yes' });
    }
    finally {
      const finalRunLease = mutationIntentPersisted ? mutationRunLease : runLease;
      if (runLeaseIsCurrent(finalRunLease)) setBusy(false);
    }
  }

  async function verifyCard() {
    setBusy(true); setError('');
    const runLease = captureRunLease();
    let activeRunLease = runLease;
    let lease = null;
    try {
      assertActiveRunLease(runLease);
      const mutation = productionCardAuthority(currentCardLink(), runLease.expectedCardId, authorityOptions('runtime')).ok
        ? 'runtime' : 'readback';
      lease = captureCardLease(mutation, runLease);
      const evidence = testDriver()?.readEvidence ? await testDriver().readEvidence('verify') : await readCardProjectEvidence({ host: lease.host, transport: lease.transport });
      assertCardLease(lease, mutation);
      assertActiveRunLease(runLease);
      if (!exactEvidence(evidence, job, runLease.expectedCardId, release.value)) {
        if (evidence.cardId !== runLease.expectedCardId) throw new Error(`Wrong card. Expected ${runLease.expectedCardId}, but read back ${evidence.cardId}. No retry was unlocked.`);
        if (evidence.firmwareVersion !== release.value.manifest.firmwareVersion || evidence.buildId !== release.value.manifest.buildId) throw new Error('Card firmware changed after restore. No retry was unlocked.');
        const restoringRun = await advance('restore', { usbReleased: true }, runLease);
        activeRunLease = Object.freeze(correlation(restoringRun));
        assertActiveRunLease(activeRunLease);
        restoreStartedRef.current = false;
        throw new Error('Card read-back does not match this job and firmware. No second restore ran; review the evidence, then explicitly retry if appropriate.');
      }
      if (lease.transport === 'bridge' && lease.commissioningFlowId) {
        // Independent project evidence proves what was saved; a separate fresh
        // status envelope proves that this exact post-config lifecycle is now
        // command-ready before the one-time commissioning authority is cleared.
        await readCardStatusEnvelope({ host: lease.host, transport: lease.transport });
        assertCardLease(lease, mutation);
        assertActiveRunLease(runLease);
        await revalidateSharedCommissionedCard({
          expectedCardId: runLease.expectedCardId,
          host: lease.host,
          flowId: lease.commissioningFlowId,
          bridgeLifecycle: lease.bridgeLifecycle,
        });
        assertActiveRunLease(runLease);
        // Keep the commissioning correlation until cardLink has consumed its
        // own fresh status read as well. Clearing it earlier would strand the
        // bridge at runtime-ready while Studio still held stale blank evidence.
        await waitForRuntimeAuthority(runLease.expectedCardId, runLease);
        await adoptVerifiedBridgeIdentity(lease.commissioningFlowId, lease, mutation);
        assertActiveRunLease(runLease);
      } else if (lease.transport === 'direct') {
        for (let freshRead = 0; freshRead < 2; freshRead += 1) {
          const readiness = await readCardStatusEnvelope({ host: lease.host, transport: 'direct' });
          reportDirectCardStatus({ connected: true, host: lease.host, status: readiness });
          assertActiveRunLease(runLease);
        }
      }
      await waitForRuntimeAuthority(runLease.expectedCardId, runLease);
      const checkingRun = await advance('check-lights', {}, runLease);
      activeRunLease = Object.freeze(correlation(checkingRun));
      assertActiveRunLease(activeRunLease);
      setStatus('Card identity and artwork match exactly. Check every physical output before recording a pass.');
    } catch (reason) {
      if (reason?.code === 'stale-production-run' || !runLeaseIsCurrent(activeRunLease)) return;
      if (lease && reason?.code !== 'stale-production-run') invalidateOperation(lease, 'production-readback-failed');
      if (/does not match this job|no second restore/i.test(String(reason?.message || ''))) showRecovery('restore-readback-mismatch');
      else if (/wrong card/i.test(String(reason?.message || ''))) showRecovery('wrong-card-reconnect');
      else showRecovery('restore-failure', { cardChanged: 'unknown', usbReleased: 'yes' });
    }
    finally { if (runLeaseIsCurrent(activeRunLease)) setBusy(false); }
  }

  async function continueAfterLights(results = observations) {
    if (!Array.isArray(results) || !results.length || !results.every(result => result?.result === 'correct')) return;
    const runLease = captureRunLease();
    try { assertRunLease(runLease); assertCardLease(captureCardLease('runtime', runLease), 'runtime'); }
    catch (reason) { setError(`${reason.message} Physical results were not advanced to a pass.`); return; }
    setObservations(results);
    setRecordRecoveryNeeded(false);
    await advance('record', {}, runLease);
    setStatus('Physical observations are complete. Enter the worker identifier and save the pass.');
  }

  async function savePass() {
    if (!workerId.trim() || busy || savingPassRef.current) return;
    savingPassRef.current = true; setBusy(true); setError('');
    const runLease = captureRunLease();
    const finalWorkerId = workerId.trim();
    const finalObservations = observations;
    let lease = null;
    try {
      assertRunLease(runLease);
      lease = captureCardLease('runtime', runLease);
      const evidence = testDriver()?.readEvidence ? await testDriver().readEvidence('record') : await readCardProjectEvidence({ host: lease.host, transport: lease.transport });
      assertCardLease(lease, 'runtime');
      assertRunLease(runLease);
      if (!exactEvidence(evidence, job, runLease.expectedCardId, release.value)) throw new Error('The final card identity changed.');
      const driver = testDriver();
      const wiringStatus = driver?.readWiringStatus ? await driver.readWiringStatus() : await getCardWiringStatus({ host: lease.host, transport: lease.transport });
      assertCardLease(lease, 'runtime');
      assertRunLease(runLease);
      assertProductionFinalWiringStatus({
        status: wiringStatus, job, cardId: runLease.expectedCardId,
        firmwareVersion: release.value.manifest.firmwareVersion, buildId: release.value.manifest.buildId,
        physicalResults: finalObservations,
      });
      setRecordRecoveryNeeded(false);
      assertRunLease(runLease);
      const existing = readProductionRecords().some(record => record.runId === runLease.runId);
      if (!existing) {
        assertCardLease(lease, 'runtime');
        assertRunLease(runLease);
        appendProductionRecord({
          runId: runLease.runId, jobId: job.jobId, jobDigest: job.digest, artwork: job.artwork, batch: job.batch,
          cardId: evidence.cardId, firmwareVersion: evidence.firmwareVersion, firmwareBuildId: evidence.buildId,
          projectRevision: evidence.projectRevision, projectFingerprint: evidence.projectFingerprint,
          restoredControls: Object.keys(job.configuration.config.controls || {}).filter(key => job.configuration.config.controls[key] !== -1),
          physicalResults: finalObservations,
          activationConfirmed: true, workerId: finalWorkerId, passedAt: new Date().toISOString(),
        });
      }
      await advance('complete', {}, runLease);
      setRecordRefresh(value => value + 1);
      setStatus('Pass recorded on this browser. Export records before changing computers.');
    } catch (reason) {
      if (lease && reason?.code !== 'stale-production-run') invalidateOperation(lease, 'production-final-pass-failed');
      if (reason?.recoveryAction === 'rerun-lights') setRecordRecoveryNeeded(true);
      setError(`Pass was not completed. ${reason?.message || 'Local record storage or card read-back failed.'} Your checks remain here; fix the issue and save again.`);
    } finally {
      savingPassRef.current = false; setBusy(false);
    }
  }

  async function resetTransient(nextStatus, runLease) {
    const released = await releaseUsbConnection();
    if (!released) {
      await persistUnreleasedUsb(runLease);
      showRecovery('usb-ownership-uncertain', { usbReleased: 'unknown' });
      return false;
    }
    assertRunLease(runLease);
    loaderRef.current = null; transportRef.current = null;
    await clearCardCommissioning().catch(() => {});
    assertRunLease(runLease);
    for (const key of [PRODUCTION_RUN_COMMIT_A_KEY, PRODUCTION_RUN_COMMIT_B_KEY, PRODUCTION_RUN_SLOT_A_KEY, PRODUCTION_RUN_SLOT_B_KEY]) localStorage.removeItem(key);
    runRef.current = null;
    const hash = new URLSearchParams(window.location.hash.slice(1)); hash.delete('job');
    if (!(hash.get('screen') === 'card' && hash.get('section') === 'workshop')) hash.set('screen', 'production');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    setJob(null); setRun(null); setRelease({ state: 'idle', value: null, error: '' }); setHardware(null); setUsbConnected(false); setFirmwareDecision('uninspected'); setRecovery(null);
    setObservations({}); setWorkerId(''); setProgress(0); setError(''); setRecordRecoveryNeeded(false); restoreStartedRef.current = false;
    setStatus(nextStatus);
    return true;
  }

  async function changeJob() {
    if (busy || !['connect-card', 'inspect', 'restore'].includes(run?.state) || run?.cardChanged || restoreStartedRef.current) return;
    const runLease = captureRunLease();
    setBusy(true);
    try { await resetTransient('Job selection cleared. No card was changed; completed pass records were kept.', runLease); }
    finally { setBusy(false); }
  }

  async function nextArtwork() {
    const runLease = captureRunLease();
    await resetTransient('Ready for the next artwork. The completed pass records were kept.', runLease);
  }

  async function handlePhysicalRecovery(action) {
    if (busy || !['restore-project', 'signed-firmware-recovery', 'rerun-lights'].includes(action)) return;
    const runLease = captureRunLease();
    setBusy(true); setError('');
    try {
      const target = action === 'restore-project' ? 'restore' : action === 'rerun-lights' ? 'check-lights' : 'connect-card';
      if (target === 'connect-card' && !await releaseUsbConnection()) {
        await persistUnreleasedUsb(runLease);
        showRecovery('usb-ownership-uncertain', { usbReleased: 'unknown' });
        return;
      }
      const updated = await updateProductionRunAtomically(current => {
        const recovery = transitionProductionRun(current, 'recovery', { correlation: runLease, recoveryAction: action, usbReleased: true });
        return transitionProductionRun(recovery, target, { correlation: correlation(recovery), usbReleased: true });
      });
      runRef.current = updated;
      setRun(updated); setObservations({}); setRecordRecoveryNeeded(false); restoreStartedRef.current = false;
      if (target === 'restore') {
        setStatus('Physical verification stopped. Load the exact verified artwork again, then independently verify the card.');
      } else if (target === 'check-lights') {
        setStatus('Final card wiring changed. Re-check every physical boundary before saving a pass.');
      } else {
        loaderRef.current = null; transportRef.current = null;
        setHardware(null); setUsbConnected(false); setFirmwareDecision('uninspected');
        setStatus('Firmware evidence changed. Reconnect the same USB card and inspect it before any firmware decision.');
      }
    } catch (reason) {
      setError(`Safe recovery could not be saved. The light test remains stopped. ${reason?.message || reason}`);
    } finally { setBusy(false); }
  }

  async function handleRecoveryAction(action) {
    const current = recovery;
    if (!current || busy) return;
    const recoveryRunLease = captureRunLease();
    if (action === 'prepare-erased-install') {
      assertActiveRunLease(recoveryRunLease);
      setRecovery(null);
      setFirmwareDecision('install-required');
      setStatus('No card page was verified. Reconnect the same USB-inspected card to explicitly install verified firmware; Studio has not called it blank or connected.');
      await connectCard();
      return;
    }
    if (action === 'retry-signed-release') { setRecovery(null); await preloadFirmware(job); return; }
    if (action === 'retry-usb') { setRecovery(null); await connectCard(); return; }
    if (action === 'reconnect-expected-card') {
      setRecovery(null);
      if (run?.state === 'reconnect') await reconnectAfterInstall();
      else if (run?.state === 'inspect' && firmwareDecision === 'install-required') await connectCard();
      else if (run?.state === 'inspect') await retryInstalledFirmwareEvidence();
      else {
        setBusy(true);
        try { if (!testDriver()) await onConnectCard?.(cardHost); setStatus('Expected card page opened. Continue only after checking that the correct card is connected.'); }
        catch { setRecovery(classifyProductionFailure('card-page-unavailable')); }
        finally { setBusy(false); }
      }
      return;
    }
    if (action === 'verify-restore') { setRecovery(null); await verifyCard(); return; }
    if (action === 'retry-restore') { setRecovery(null); await restoreArtwork(); return; }
    if (action === 'reinspect-firmware-mismatch') {
      setBusy(true);
      try {
        const updated = await updateProductionRunAtomically(currentRun => {
          const typed = transitionProductionRun(currentRun, 'recovery', { correlation: recoveryRunLease, recoveryAction: 'signed-firmware-recovery', supportCode: current.supportCode, usbReleased: true });
          return transitionProductionRun(typed, 'connect-card', { correlation: correlation(typed), usbReleased: true });
        });
        runRef.current = updated;
        setRun(updated); setRecovery(null); setHardware(null); setUsbConnected(false); setFirmwareDecision('install-required');
        setStatus('Reconnect the same USB card. Studio will inspect its stable identity again before offering the signed firmware install.');
      } catch { setRecovery(classifyProductionFailure('usb-ownership-uncertain')); }
      finally { setBusy(false); }
      return;
    }
    if (action === 'rerun-physical') { setRecovery(null); await handlePhysicalRecovery('rerun-lights'); return; }
    if (action === 'install-firmware') { setRecovery(null); await installOrContinue(); return; }
    if (action === 'release-usb') {
      setBusy(true);
      try {
        const released = await releaseUsbConnection();
        if (!released) throw new Error('USB release remains unconfirmed.');
        assertRunLease(recoveryRunLease);
        loaderRef.current = null; transportRef.current = null;
        if (run?.state === 'complete') {
          setUsbConnected(false); setHardware(null); setRecovery(null);
          setStatus('USB released. Choose Next artwork again when you are ready.');
          return;
        }
        setUsbConnected(false); setHardware(null); setFirmwareDecision('uninspected');
        const updated = await updateProductionRunAtomically(currentRun => {
          const typed = transitionProductionRun(currentRun, 'recovery', { correlation: recoveryRunLease, recoveryAction: 'release-usb', supportCode: current.supportCode, cardChanged: currentRun.cardChanged, usbReleased: true });
          return transitionProductionRun(typed, 'connect-card', { correlation: correlation(typed), usbReleased: true });
        });
        runRef.current = updated;
        setRun(updated); setRecovery(null); setStatus('USB released. Reconnect and inspect the same card before continuing.');
      } catch (reason) {
        if (reason?.code !== 'stale-production-run' && runLeaseIsCurrent(recoveryRunLease)) {
          setRecovery(classifyProductionFailure('usb-ownership-uncertain'));
        }
      }
      finally { setBusy(false); }
    }
  }

  if (!cap.canProductionWebSerial) {
    const mobile = cap.isMobile;
    const retainedCode = new URLSearchParams(window.location.hash.slice(1)).get('job');
    const handoff = <ProductionLandmark className="prod-handoff" ref={primaryRef} tabIndex={-1}><span className="prod-kicker">Production setup</span><ProductionHeading>{mobile ? 'Continue on a workshop computer' : 'Open this page in Chrome or Edge'}</ProductionHeading><p>{mobile ? 'Production USB setup needs a desktop or laptop. On that computer, open led.mandalacodes.com in Chrome or Edge and choose Production setup.' : 'Use the secure top-level led.mandalacodes.com page in desktop Chrome or Edge. Studio uses direct local HTTP when allowed and the existing card-page bridge from HTTPS.'}</p><code>led.mandalacodes.com/#screen=production{retainedCode ? `&job=${retainedCode}` : ''}</code>{retainedCode && <p>Job code <strong>{retainedCode}</strong> is retained in this address.</p>}</ProductionLandmark>;
    return embedded ? <div className="prod-screen prod-embedded">{handoff}</div> : <div className="screen prod-screen">{handoff}</div>;
  }

  const currentStage = stageIndex(run?.state);
  const requestedJobCode = new URLSearchParams(window.location.hash.slice(1)).get('job') || '';
  const canChangeJob = Boolean(job && ['connect-card', 'inspect', 'restore'].includes(run?.state) && !run?.cardChanged && !restoreStartedRef.current);
  const retainedUsb = usbOwnershipRef.current;
  const usbOwnershipForeign = Boolean(usbOwnershipBlocked && retainedUsb.connection
    && (retainedUsb.ownerRunId !== run?.runId || run?.usbReleased === false));
  return (
    <div className={embedded ? 'prod-screen prod-embedded' : 'screen prod-screen'}>
      <div className={embedded ? 'prod-embedded-scroll' : 'screen-scroll'}>
        <ProductionLandmark className="prod-shell">
          <header className="prod-hero">
            <div><span className="prod-kicker">Workshop · browser USB</span><ProductionHeading ref={primaryRef} tabIndex={-1}>Production setup</ProductionHeading><p>One card, one verified artwork, one physical pass. No firmware files or GPIO tables.</p></div>
            <div className="prod-safety"><span aria-hidden="true">●</span> Chrome/Edge · secure USB · verified local card link</div>
          </header>
          <ol className="prod-steps" aria-label="Production progress">{STEPS.map(([id, label], index) => <li key={id} className={index < currentStage ? 'done' : index === currentStage ? 'current' : ''} aria-current={index === currentStage ? 'step' : undefined}><span>{index < currentStage ? '✓' : index + 1}</span>{label}</li>)}</ol>
          <div className="prod-layout">
            <div className="prod-work">
              {!job && <ProductionJobPicker selectedJob={job} onSelect={selectJob} requestedCode={requestedJobCode} />}
              {job && <ProductionJobPicker selectedJob={job} onSelect={selectJob} disabled />}
              {job && <section className="prod-action" ref={actionRef} aria-live="polite">
                <div className="prod-section-head"><div><span className="prod-kicker">Current action</span><h2>{run?.state?.replaceAll('-', ' ') || 'Preparing'}</h2></div>{hardware && <span className="prod-card-id">{hardware.cardId}</span>}</div>
                <p className="prod-status" role="status">{status}</p>
                {release.state === 'loading' && <p>Verifying and preloading official firmware…</p>}
                {release.state === 'error' && !recovery && <p className="prod-error" role="alert">Official firmware could not be preloaded. USB stays locked.</p>}
                {!recovery && <>{run?.state === 'connect-card' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready' || usbOwnershipForeign} onClick={connectCard}>{busy ? 'Inspecting card…' : 'Connect one USB card'}</button>}
                {usbOwnershipForeign && retainedUsb.connection && <button className="btn" type="button" disabled={busy || retainedUsb.releasing} onClick={() => void releaseRetainedUsbOwnership()}>{retainedUsb.releasing ? 'Releasing retained USB…' : 'Release retained USB safely'}</button>}
                {run?.state === 'inspect' && !hardware && firmwareDecision === 'uninspected' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready' || usbOwnershipForeign} onClick={connectCard}>{busy ? 'Inspecting same card…' : 'Reconnect same USB card'}</button>}
                {run?.state === 'inspect' && hardware && firmwareDecision === 'uninspected' && <button className="btn primary" type="button" disabled={busy || !usbConnected || usbOwnershipForeign} onClick={inspectInstalledFirmware}>{busy ? 'Releasing USB…' : 'Release USB and inspect firmware'}</button>}
                {run?.state === 'inspect' && firmwareDecision === 'unproven' && <button className="btn primary" type="button" disabled={busy} onClick={retryInstalledFirmwareEvidence}>{busy ? 'Connecting to card page…' : 'Reconnect card page and retry'}</button>}
                {run?.state === 'inspect' && firmwareDecision === 'install-required' && !usbConnected && <button className="btn primary" type="button" disabled={busy || usbOwnershipForeign} onClick={connectCard}>{busy ? 'Inspecting same card…' : 'Reconnect same USB card'}</button>}
                {run?.state === 'inspect' && hardware && firmwareDecision === 'install-required' && usbConnected && <button className="btn primary" type="button" disabled={busy || usbOwnershipForeign} onClick={installOrContinue}>Install verified firmware</button>}
                {run?.state === 'install' && <div className="prod-progress" role="progressbar" aria-label="Installing verified firmware" aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
                {run?.state === 'reconnect' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready'} onClick={reconnectAfterInstall}>{busy ? 'Checking same card…' : 'Reconnect same card'}</button>}
                {run?.state === 'restore' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready' || restoreStartedRef.current || !configAuthority.ok} onClick={restoreArtwork}>{busy ? 'Loading artwork once…' : 'Load verified artwork'}</button>}
                {run?.state === 'verify-card' && !recovery && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready' || (!runtimeAuthority.ok && !readbackAuthority.ok)} onClick={verifyCard}>{busy ? 'Reading card…' : 'Verify card read-back'}</button>}
                {run?.state === 'check-lights' && <ProductionPhysicalTest job={job} runId={run.runId} cardLink={cardLink} expectedCardId={run.expectedCardId} platform={diagnosticPlatform(cap)} onResultsChange={setObservations} onComplete={continueAfterLights} onRecovery={handlePhysicalRecovery} />}
                {run?.state === 'record' && <><form className="prod-record-form" onSubmit={event => { event.preventDefault(); void savePass(); }}><label htmlFor="prod-worker">Worker initials or ID</label><input id="prod-worker" value={workerId} maxLength={80} onChange={event => setWorkerId(event.target.value)} /><button className="btn primary" disabled={!workerId.trim() || busy || !runtimeAuthority.ok}>{busy ? 'Saving pass…' : 'Save pass record'}</button></form>{recordRecoveryNeeded && <button className="btn" type="button" disabled={busy} onClick={() => void handlePhysicalRecovery('rerun-lights')}>Re-run physical checks</button>}</>}
                {run?.state === 'complete' && <div className="prod-complete"><strong>Artwork passed</strong><p>The card, exact job, and physical outputs were recorded.</p><button className="btn primary" onClick={nextArtwork}>Next artwork</button></div>}</>}
                {canChangeJob && !recovery && <button className="btn prod-change-job" type="button" disabled={busy} onClick={changeJob}>Change job</button>}
                {error && <p className="prod-error" role="alert">{error}</p>}
                {recovery && <ProductionRecovery
                  recovery={recovery}
                  phase={run?.state || 'unknown'}
                  firmwareTarget={job && release.value ? `${job.firmware.target}@${job.firmware.version}+${job.firmware.buildId.slice(0, 8)}` : job ? `${job.firmware.target}@${job.firmware.version}` : 'unknown'}
                  hardware={hardware}
                  platform={diagnosticPlatform(cap)}
                  onAction={action => void handleRecoveryAction(action)}
                />}
                {recovery?.supportCode === 'LW-CARD-202' && run?.state === 'inspect' && hardware && firmwareDecision === 'unproven' && !usbConnected && <button className="btn" type="button" disabled={busy} onClick={() => void handleRecoveryAction('prepare-erased-install')}>Reconnect same USB card to install verified firmware</button>}
              </section>}
            </div>
            <aside><ProductionPassRecord refreshKey={recordRefresh} /></aside>
          </div>
        </ProductionLandmark>
      </div>
    </div>
  );
}
