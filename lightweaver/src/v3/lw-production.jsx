import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProductionJobPicker } from '../components/production/ProductionJobPicker.jsx';
import { ProductionPassRecord } from '../components/production/ProductionPassRecord.jsx';
import { ProductionPhysicalTest } from '../components/production/ProductionPhysicalTest.jsx';
import { ProductionRecovery } from '../components/production/ProductionRecovery.jsx';
import { clearCardCommissioning } from '../lib/cardCommissioningFlow.js';
import { readCardProjectEvidence, pushConfigToCard } from '../lib/cardPushClient.js';
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
  return run && { runId: run.runId, flowId: run.flowId, jobDigest: run.jobDigest, operationId: run.operationId, expectedCardId: run.expectedCardId };
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

export function ProductionScreen({ cardHost, onConnectCard }) {
  const cap = useMemo(capabilities, []);
  const [job, setJob] = useState(null);
  const [run, setRun] = useState(() => readProductionRun());
  const [release, setRelease] = useState({ state: 'idle', value: null, error: '' });
  const [hardware, setHardware] = useState(null);
  const [usbConnected, setUsbConnected] = useState(false);
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
  const restoreStartedRef = useRef(false);
  const savingPassRef = useRef(false);
  const previousStateRef = useRef(run?.state);

  const advance = useCallback(async (next, options = {}) => {
    const updated = await updateProductionRunAtomically(current => transitionProductionRun(current, next, { correlation: correlation(current), ...options }));
    setRun(updated);
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

  useEffect(() => () => { void disconnectESP(loaderRef.current, transportRef.current); }, []);
  useEffect(() => { primaryRef.current?.focus(); }, []);
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
    hash.set('screen', 'production'); hash.set('job', selected.jobId);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    await preloadFirmware(selected);
  }

  function testDriver() {
    return import.meta.env.DEV ? window.__LW_PRODUCTION_DRIVER_FOR_TEST__ : null;
  }

  async function releaseUsbConnection(connection = { loader: loaderRef.current, transport: transportRef.current }) {
    if (!connection?.loader && !connection?.transport && !testDriver()) return true;
    try {
      const result = testDriver()?.disconnect
        ? await testDriver().disconnect(connection)
        : await disconnectESP(connection?.loader, connection?.transport);
      return result !== false;
    } catch { return false; }
  }

  async function persistUnreleasedUsb() {
    try {
      const updated = await updateProductionRunAtomically(currentRun => {
        const typed = transitionProductionRun(currentRun, 'recovery', { correlation: correlation(currentRun), recoveryAction: 'release-usb', usbReleased: false });
        return transitionProductionRun(typed, 'connect-card', { correlation: correlation(typed), usbReleased: false });
      });
      setRun(updated);
    } catch { /* the visible recovery remains conservative even if persistence is unavailable */ }
  }

  async function connectCard() {
    if (busy || release.state !== 'ready') return;
    setBusy(true); setError(''); setRecovery(null); setStatus('Select the one Lightweaver card connected by USB.');
    let connection = null;
    try {
      const driver = testDriver();
      connection = driver?.connectCard ? await driver.connectCard() : await connectESP();
      const rawInspection = driver?.inspectCard ? await driver.inspectCard(connection) : await inspectConnectedESP(connection.loader, connection.chip);
      const inspected = { ...rawInspection, ...validateInstallHardware(rawInspection) };
      if (run?.expectedCardId && inspected.cardId !== run.expectedCardId) {
        throw new Error(`Wrong card. Reconnect ${run.expectedCardId}; this card is ${inspected.cardId}. Nothing was changed.`);
      }
      loaderRef.current = connection.loader;
      transportRef.current = connection.transport;
      setUsbConnected(true);
      setHardware(inspected);
      setRecovery(null);
      if (run.state === 'connect-card') await advance('inspect', { expectedCardId: inspected.cardId });
      setStatus(`Card ${inspected.cardId} inspected. Nothing has been changed.`);
    } catch (reason) {
      const acquired = Boolean(connection);
      const released = acquired ? await releaseUsbConnection(connection) : true;
      loaderRef.current = released ? null : connection?.loader || null;
      transportRef.current = released ? null : connection?.transport || null;
      setUsbConnected(!released); setHardware(null);
      if (!released) await persistUnreleasedUsb();
      showRecovery(reason, { phase: run?.state || 'connect-card', cardChanged: 'no', usbReleased: released ? 'yes' : 'unknown' });
    }
    finally { setBusy(false); }
  }

  async function inspectInstalledFirmware() {
    if (busy || !hardware || !usbConnected || run.state !== 'inspect') return;
    setBusy(true); setError('');
    try {
      const connection = { loader: loaderRef.current, transport: transportRef.current };
      const released = await releaseUsbConnection(connection);
      if (released) { loaderRef.current = null; transportRef.current = null; setUsbConnected(false); }
      if (!released) throw new Error('USB ownership could not be released.');
      await readInstalledFirmwareEvidence();
    } catch (reason) {
      setFirmwareDecision('unproven');
      showRecovery('usb-ownership-uncertain');
    } finally { setBusy(false); }
  }

  async function readInstalledFirmwareEvidence() {
    try {
      const driver = testDriver();
      // Opening/reconnecting the local card page is the required HTTPS → local
      // handoff. The verified job and firmware remain resident in this screen.
      if (driver?.connectLan) await driver.connectLan();
      else await onConnectCard?.(cardHost);
      driver?.noteLanHandoff?.();
      const evidence = driver?.readEvidence ? await driver.readEvidence('preflight') : await readCardProjectEvidence({ host: cardHost });
      if (!evidence?.cardId) throw new Error('The card page did not return card identity.');
      if (evidence.cardId !== run.expectedCardId) {
        throw new Error(`Wrong online card. USB identified ${run.expectedCardId}, but the card page reports ${evidence.cardId}. Nothing was changed.`);
      }
      const exact = evidence.firmwareVersion === release.value.manifest.firmwareVersion && evidence.buildId === release.value.manifest.buildId;
      if (exact) {
        setRecovery(null);
        setFirmwareDecision('exact');
        await advance('restore', { usbReleased: true });
        setStatus('The online card is the same USB card and already has the exact official firmware. Ready to load the artwork.');
      } else {
        setFirmwareDecision('install-required');
        setHardware(null);
        setStatus(`Card ${evidence.cardId} reports firmware ${evidence.firmwareVersion} (${evidence.buildId.slice(0, 8)}), which does not match the verified release. Reconnect the same USB card to update it.`);
      }
    } catch (reason) {
      setFirmwareDecision('unproven');
      if (/wrong online card/i.test(String(reason?.message || ''))) showRecovery('wrong-card-reconnect');
      else showRecovery('card-page-unavailable');
    }
  }

  async function retryInstalledFirmwareEvidence() {
    if (busy || run.state !== 'inspect') return;
    setBusy(true); setError('');
    try { await readInstalledFirmwareEvidence(); }
    finally { setBusy(false); }
  }

  async function installOrContinue() {
    if (busy || !hardware || release.state !== 'ready') return;
    if (firmwareDecision !== 'install-required' || !usbConnected) return;
    setBusy(true); setError('');
    try {
      await advance('install', { cardChanged: false, usbReleased: false });
        const driver = testDriver();
        if (driver?.install) await driver.install({ release: release.value, hardware, onProgress: setProgress });
        else {
          const file = new File([release.value.bytes], `lightweaver-${release.value.manifest.firmwareVersion}.bin`, { type: 'application/octet-stream' });
          await flashFirmwareAndRelease({
            loader: loaderRef.current, transport: transportRef.current, file, address: 0, eraseAll: true, flashFirmware, onProgress: setProgress,
            disconnectESP: async (loader, transport) => {
              if (!await disconnectESP(loader, transport)) throw new Error('USB release could not be confirmed after firmware installation.');
            },
          });
        }
        loaderRef.current = null; transportRef.current = null;
        setUsbConnected(false);
        await advance('reconnect', { cardChanged: true, usbReleased: true });
        setStatus('Official firmware installed and USB released. Reconnect the same card after it restarts; Studio will not install it again.');
    } catch (reason) {
      const released = await releaseUsbConnection();
      if (released) { loaderRef.current = null; transportRef.current = null; setUsbConnected(false); }
      else setUsbConnected(true);
      setHardware(null);
      try {
        await advance('recovery', { recoveryAction: 'release-usb', cardChanged: true, usbReleased: released });
        await advance('connect-card', { cardChanged: true, usbReleased: released });
      } catch {}
      showRecovery(released ? 'disconnect-phase' : 'usb-ownership-uncertain', { cardChanged: 'unknown', usbReleased: released ? 'yes' : 'unknown' });
    }
    finally { setBusy(false); }
  }

  async function reconnectAfterInstall() {
    setBusy(true); setError('');
    try {
      const driver = testDriver();
      if (!driver) await onConnectCard?.(cardHost);
      const evidence = driver?.readEvidence ? await driver.readEvidence('reconnect') : await readCardProjectEvidence({ host: cardHost });
      if (evidence.cardId !== run.expectedCardId) throw new Error(`Wrong card. Reconnect ${run.expectedCardId}; the online card is ${evidence.cardId}.`);
      if (evidence.firmwareVersion !== release.value.manifest.firmwareVersion || evidence.buildId !== release.value.manifest.buildId) {
        showRecovery('firmware-mismatch', { cardChanged: run?.cardChanged ? 'yes' : 'no', firmwareEvidence: {
          exactCard: true, installedVersion: evidence.firmwareVersion, installedBuildId: evidence.buildId,
          targetVersion: release.value.manifest.firmwareVersion, targetBuildId: release.value.manifest.buildId,
        } });
        return;
      }
      await advance('restore', { usbReleased: true });
      setStatus('The same card is online with the exact firmware. Ready to load the artwork once.');
    } catch (reason) { showRecovery(reason, { phase: 'reconnect', usbReleased: 'yes' }); }
    finally { setBusy(false); }
  }

  async function restoreArtwork() {
    if (busy || restoreStartedRef.current || run.state !== 'restore') return;
    restoreStartedRef.current = true; setBusy(true); setError('');
    let mutationIntentPersisted = false;
    try {
      const driver = testDriver();
      const binding = driver?.readEvidence ? await driver.readEvidence('before-restore') : await readCardProjectEvidence({ host: cardHost });
      if (binding.cardId !== run.expectedCardId
        || binding.firmwareVersion !== release.value.manifest.firmwareVersion
        || binding.buildId !== release.value.manifest.buildId) {
        throw new Error('The online card is no longer the exact USB-inspected card and firmware. Nothing was restored.');
      }
      // Commit the one-time mutation intention before the POST. A crash after
      // this point resumes at independent read-back and can never replay the
      // restore automatically.
      await advance('verify-card', { usbReleased: true });
      mutationIntentPersisted = true;
      if (driver?.restore) await driver.restore(job.configuration);
      else await pushConfigToCard(job.configuration, { host: cardHost, reboot: 'if-needed', allowProjectChange: true, allowLayoutChange: true });
      setStatus('Artwork was sent once. Now Studio will read the card back independently.');
    } catch (reason) {
      if (!mutationIntentPersisted) restoreStartedRef.current = false;
      if (mutationIntentPersisted) showRecovery('restore-failure', { cardChanged: 'unknown', usbReleased: 'yes' });
      else showRecovery(/exact USB-inspected card/i.test(String(reason?.message || '')) ? 'wrong-card-reconnect' : 'restore-failure', { cardChanged: 'no', usbReleased: 'yes' });
    }
    finally { setBusy(false); }
  }

  async function verifyCard() {
    setBusy(true); setError('');
    try {
      const evidence = testDriver()?.readEvidence ? await testDriver().readEvidence('verify') : await readCardProjectEvidence({ host: cardHost });
      if (!exactEvidence(evidence, job, run.expectedCardId, release.value)) {
        if (evidence.cardId !== run.expectedCardId) throw new Error(`Wrong card. Expected ${run.expectedCardId}, but read back ${evidence.cardId}. No retry was unlocked.`);
        if (evidence.firmwareVersion !== release.value.manifest.firmwareVersion || evidence.buildId !== release.value.manifest.buildId) throw new Error('Card firmware changed after restore. No retry was unlocked.');
        await advance('restore', { usbReleased: true });
        restoreStartedRef.current = false;
        throw new Error('Card read-back does not match this job and firmware. No second restore ran; review the evidence, then explicitly retry if appropriate.');
      }
      await advance('check-lights');
      setStatus('Card identity and artwork match exactly. Check every physical output before recording a pass.');
    } catch (reason) {
      if (/does not match this job|no second restore/i.test(String(reason?.message || ''))) showRecovery('restore-readback-mismatch');
      else if (/wrong card/i.test(String(reason?.message || ''))) showRecovery('wrong-card-reconnect');
      else showRecovery('restore-failure', { cardChanged: 'unknown', usbReleased: 'yes' });
    }
    finally { setBusy(false); }
  }

  async function continueAfterLights(results = observations) {
    if (!Array.isArray(results) || !results.length || !results.every(result => result?.result === 'correct')) return;
    setObservations(results);
    setRecordRecoveryNeeded(false);
    await advance('record');
    setStatus('Physical observations are complete. Enter the worker identifier and save the pass.');
  }

  async function savePass() {
    if (!workerId.trim() || busy || savingPassRef.current) return;
    savingPassRef.current = true; setBusy(true); setError('');
    try {
      const evidence = testDriver()?.readEvidence ? await testDriver().readEvidence('record') : await readCardProjectEvidence({ host: cardHost });
      if (!exactEvidence(evidence, job, run.expectedCardId, release.value)) throw new Error('The final card identity changed.');
      const driver = testDriver();
      const wiringStatus = driver?.readWiringStatus ? await driver.readWiringStatus() : await getCardWiringStatus({ host: cardHost });
      assertProductionFinalWiringStatus({
        status: wiringStatus, job, cardId: run.expectedCardId,
        firmwareVersion: release.value.manifest.firmwareVersion, buildId: release.value.manifest.buildId,
        physicalResults: observations,
      });
      setRecordRecoveryNeeded(false);
      const existing = readProductionRecords().some(record => record.runId === run.runId);
      if (!existing) {
        appendProductionRecord({
          runId: run.runId, jobId: job.jobId, jobDigest: job.digest, artwork: job.artwork, batch: job.batch,
          cardId: evidence.cardId, firmwareVersion: evidence.firmwareVersion, firmwareBuildId: evidence.buildId,
          projectRevision: evidence.projectRevision, projectFingerprint: evidence.projectFingerprint,
          restoredControls: Object.keys(job.configuration.config.controls || {}).filter(key => job.configuration.config.controls[key] !== -1),
          physicalResults: observations,
          activationConfirmed: true, workerId: workerId.trim(), passedAt: new Date().toISOString(),
        });
      }
      await advance('complete');
      setRecordRefresh(value => value + 1);
      setStatus('Pass recorded on this browser. Export records before changing computers.');
    } catch (reason) {
      if (reason?.recoveryAction === 'rerun-lights') setRecordRecoveryNeeded(true);
      setError(`Pass was not completed. ${reason?.message || 'Local record storage or card read-back failed.'} Your checks remain here; fix the issue and save again.`);
    } finally {
      savingPassRef.current = false; setBusy(false);
    }
  }

  async function resetTransient(nextStatus) {
    const released = await releaseUsbConnection();
    if (!released) {
      await persistUnreleasedUsb();
      showRecovery('usb-ownership-uncertain', { usbReleased: 'unknown' });
      return false;
    }
    loaderRef.current = null; transportRef.current = null;
    await clearCardCommissioning().catch(() => {});
    for (const key of [PRODUCTION_RUN_COMMIT_A_KEY, PRODUCTION_RUN_COMMIT_B_KEY, PRODUCTION_RUN_SLOT_A_KEY, PRODUCTION_RUN_SLOT_B_KEY]) localStorage.removeItem(key);
    const hash = new URLSearchParams(window.location.hash.slice(1)); hash.delete('job'); hash.set('screen', 'production');
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
    setJob(null); setRun(null); setRelease({ state: 'idle', value: null, error: '' }); setHardware(null); setUsbConnected(false); setFirmwareDecision('uninspected'); setRecovery(null);
    setObservations({}); setWorkerId(''); setProgress(0); setError(''); setRecordRecoveryNeeded(false); restoreStartedRef.current = false;
    setStatus(nextStatus);
    return true;
  }

  async function changeJob() {
    if (busy || !['connect-card', 'inspect', 'restore'].includes(run?.state) || run?.cardChanged || restoreStartedRef.current) return;
    setBusy(true);
    try { await resetTransient('Job selection cleared. No card was changed; completed pass records were kept.'); }
    finally { setBusy(false); }
  }

  async function nextArtwork() {
    await resetTransient('Ready for the next artwork. The completed pass records were kept.');
  }

  async function handlePhysicalRecovery(action) {
    if (busy || !['restore-project', 'signed-firmware-recovery', 'rerun-lights'].includes(action)) return;
    setBusy(true); setError('');
    try {
      const target = action === 'restore-project' ? 'restore' : action === 'rerun-lights' ? 'check-lights' : 'connect-card';
      if (target === 'connect-card' && !await releaseUsbConnection()) {
        await persistUnreleasedUsb();
        showRecovery('usb-ownership-uncertain', { usbReleased: 'unknown' });
        return;
      }
      const updated = await updateProductionRunAtomically(current => {
        const recovery = transitionProductionRun(current, 'recovery', { correlation: correlation(current), recoveryAction: action, usbReleased: true });
        return transitionProductionRun(recovery, target, { correlation: correlation(recovery), usbReleased: true });
      });
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
          const typed = transitionProductionRun(currentRun, 'recovery', { correlation: correlation(currentRun), recoveryAction: 'signed-firmware-recovery', supportCode: current.supportCode, usbReleased: true });
          return transitionProductionRun(typed, 'connect-card', { correlation: correlation(typed), usbReleased: true });
        });
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
        const driver = testDriver();
        const released = await releaseUsbConnection();
        if (!released) throw new Error('USB release remains unconfirmed.');
        loaderRef.current = null; transportRef.current = null;
        if (run?.state === 'complete') {
          setUsbConnected(false); setHardware(null); setRecovery(null);
          setStatus('USB released. Choose Next artwork again when you are ready.');
          return;
        }
        setUsbConnected(false); setHardware(null); setFirmwareDecision('uninspected');
        const updated = await updateProductionRunAtomically(currentRun => {
          const typed = transitionProductionRun(currentRun, 'recovery', { correlation: correlation(currentRun), recoveryAction: 'release-usb', supportCode: current.supportCode, cardChanged: currentRun.cardChanged, usbReleased: true });
          return transitionProductionRun(typed, 'connect-card', { correlation: correlation(typed), usbReleased: true });
        });
        setRun(updated); setRecovery(null); setStatus('USB released. Reconnect and inspect the same card before continuing.');
      } catch { setRecovery(classifyProductionFailure('usb-ownership-uncertain')); }
      finally { setBusy(false); }
    }
  }

  if (!cap.canProductionWebSerial) {
    const mobile = cap.isMobile;
    const retainedCode = new URLSearchParams(window.location.hash.slice(1)).get('job');
    return <div className="screen prod-screen"><main className="prod-handoff" ref={primaryRef} tabIndex={-1}><span className="prod-kicker">Production setup</span><h1>{mobile ? 'Continue on a workshop computer' : 'Open this page in Chrome or Edge'}</h1><p>{mobile ? 'Production USB setup needs a desktop or laptop. On that computer, open led.mandalacodes.com in Chrome or Edge and choose Production setup.' : 'Use the secure top-level led.mandalacodes.com page in desktop Chrome or Edge. This workflow does not use or install Lightweaver Bridge.'}</p><code>led.mandalacodes.com/#screen=production{retainedCode ? `&job=${retainedCode}` : ''}</code>{retainedCode && <p>Job code <strong>{retainedCode}</strong> is retained in this address.</p>}</main></div>;
  }

  const currentStage = stageIndex(run?.state);
  const requestedJobCode = new URLSearchParams(window.location.hash.slice(1)).get('job') || '';
  const canChangeJob = Boolean(job && ['connect-card', 'inspect', 'restore'].includes(run?.state) && !run?.cardChanged && !restoreStartedRef.current);
  return (
    <div className="screen prod-screen">
      <div className="screen-scroll">
        <main className="prod-shell">
          <header className="prod-hero">
            <div><span className="prod-kicker">Workshop · browser USB</span><h1 ref={primaryRef} tabIndex={-1}>Production setup</h1><p>One card, one verified artwork, one physical pass. No firmware files or GPIO tables.</p></div>
            <div className="prod-safety"><span aria-hidden="true">●</span> Chrome/Edge · secure USB · no Bridge</div>
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
                {!recovery && <>{run?.state === 'connect-card' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready'} onClick={connectCard}>{busy ? 'Inspecting card…' : 'Connect one USB card'}</button>}
                {run?.state === 'inspect' && hardware && firmwareDecision === 'uninspected' && <button className="btn primary" type="button" disabled={busy || !usbConnected} onClick={inspectInstalledFirmware}>{busy ? 'Releasing USB…' : 'Release USB and inspect firmware'}</button>}
                {run?.state === 'inspect' && firmwareDecision === 'unproven' && <button className="btn primary" type="button" disabled={busy} onClick={retryInstalledFirmwareEvidence}>{busy ? 'Connecting to card page…' : 'Reconnect card page and retry'}</button>}
                {run?.state === 'inspect' && firmwareDecision === 'install-required' && !usbConnected && <button className="btn primary" type="button" disabled={busy} onClick={connectCard}>{busy ? 'Inspecting same card…' : 'Reconnect same USB card'}</button>}
                {run?.state === 'inspect' && hardware && firmwareDecision === 'install-required' && usbConnected && <button className="btn primary" type="button" disabled={busy} onClick={installOrContinue}>Install verified firmware</button>}
                {run?.state === 'install' && <div className="prod-progress" role="progressbar" aria-label="Installing verified firmware" aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>}
                {run?.state === 'reconnect' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready'} onClick={reconnectAfterInstall}>{busy ? 'Checking same card…' : 'Reconnect same card'}</button>}
                {run?.state === 'restore' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready' || restoreStartedRef.current} onClick={restoreArtwork}>{busy ? 'Loading artwork once…' : 'Load verified artwork'}</button>}
                {run?.state === 'verify-card' && <button className="btn primary" type="button" disabled={busy || release.state !== 'ready'} onClick={verifyCard}>{busy ? 'Reading card…' : 'Verify card read-back'}</button>}
                {run?.state === 'check-lights' && <ProductionPhysicalTest job={job} runId={run.runId} cardHost={cardHost} expectedCardId={run.expectedCardId} platform={diagnosticPlatform(cap)} onResultsChange={setObservations} onComplete={continueAfterLights} onRecovery={handlePhysicalRecovery} />}
                {run?.state === 'record' && <><form className="prod-record-form" onSubmit={event => { event.preventDefault(); void savePass(); }}><label htmlFor="prod-worker">Worker initials or ID</label><input id="prod-worker" value={workerId} maxLength={80} onChange={event => setWorkerId(event.target.value)} /><button className="btn primary" disabled={!workerId.trim() || busy}>{busy ? 'Saving pass…' : 'Save pass record'}</button></form>{recordRecoveryNeeded && <button className="btn" type="button" disabled={busy} onClick={() => void handlePhysicalRecovery('rerun-lights')}>Re-run physical checks</button>}</>}
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
              </section>}
            </div>
            <aside><ProductionPassRecord refreshKey={recordRefresh} /></aside>
          </div>
        </main>
      </div>
    </div>
  );
}
