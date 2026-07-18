import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../state/ProjectContext.jsx';
import { buildCardRuntimePackageFromProject } from '../../lib/cardRuntimeProject.js';
import { pushConfigToCard, readCardProjectEvidence } from '../../lib/cardPushClient.js';
import {
  activateAndWaitForCardWiring,
  confirmCardWiringCandidate,
  readCardWiringCandidateEvidence,
  rollbackCardWiringCandidate,
} from '../../lib/cardWiringSafety.js';
import { isCardLinkConnected } from '../../lib/cardLink.js';
import { compileWiring } from '../../lib/wiringCompiler.js';
import { createWiringChaseSession } from '../../lib/wiringChase.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  CARD_COMMISSIONING_STAGES,
  adaptCardRestorationReadback,
  acknowledgeCommissionedCard,
  bindCardWiringActivationEvidence,
  beginCardRestorationMutation,
  claimCardRestoration,
  clearCardCommissioning,
  completeCardInstall,
  confirmCardSetupNetworkJoined,
  markCardProjectRestored,
  readCardCommissioning,
  readCardRestorationAttempt,
  recordCardRestorationResponse,
  inspectCardCommissioning,
  releaseCardRestoration,
  returnCardProjectToSetupAfterLightCheck,
  verifyCardRestorationMutation,
  resumeInstalledCardAfterInterruption,
  stageCardProjectForPhysicalCheck,
  writeCardCommissioning,
} from '../../lib/cardCommissioningFlow.js';

const STAGE_LABELS = {
  'connect-card': 'Connect card',
  'install-safely': 'Install safely',
  'set-up-card': 'Set up card',
  'check-lights': 'Check lights',
};

function runtimePackageFromSnapshot(snapshot = {}, identity = {}) {
  return buildCardRuntimePackageFromProject({
    projectId: snapshot.id,
    projectName: snapshot.name,
    projectRevision: identity.revision,
    projectFingerprint: identity.fingerprint,
    productionJobId: identity.productionJobId,
    productionJobDigest: identity.productionJobDigest,
    strips: snapshot.layout?.strips || [],
    patchBoard: snapshot.layout?.patchBoard || null,
    wiring: snapshot.layout?.wiring || null,
    standaloneController: snapshot.devices?.standaloneController || {},
  });
}

function commissioningMarkerFrame(snapshot = {}) {
  const strips = snapshot.layout?.strips || [];
  let compiled = null;
  if (snapshot.layout?.wiring) {
    try { compiled = compileWiring({ wiring: snapshot.layout.wiring, strips }); }
    catch { compiled = null; }
  }
  const fallbackCount = strips.reduce((sum, strip) => sum + Math.max(0, Number(strip.pixelCount ?? strip.pixels?.length ?? 0)), 0);
  const outputs = compiled?.ok && compiled.outputs.length
    ? compiled.outputs
    : fallbackCount > 0 ? [{ start: 0, count: fallbackCount }] : [];
  const totalPixels = compiled?.ok && compiled.totalPixels > 0 ? compiled.totalPixels : fallbackCount;
  const frame = Array.from({ length: totalPixels }, () => '001A00');
  for (const output of outputs) {
    const start = Math.max(0, Number(output.start) || 0);
    const end = Math.min(frame.length, start + Math.max(0, Number(output.count ?? output.pixels) || 0));
    if (start >= end) continue;
    if (end - start === 1) frame[start] = '1A001A';
    else {
      frame[start] = '00001A';
      frame[end - 1] = '1A0000';
    }
  }
  return frame;
}

export function CardCommissioningSteps({ stage = 'connect-card' }) {
  const activeIndex = Math.max(0, CARD_COMMISSIONING_STAGES.indexOf(stage));
  return (
    <ol className="card-commissioning-steps" aria-label="Card setup progress">
      {CARD_COMMISSIONING_STAGES.map((id, index) => (
        <li key={id} className={index < activeIndex ? 'complete' : index === activeIndex ? 'active' : ''} aria-current={index === activeIndex ? 'step' : undefined}>
          <span aria-hidden="true">{index < activeIndex ? '✓' : index + 1}</span>
          {STAGE_LABELS[id]}
        </li>
      ))}
    </ol>
  );
}

function identityMessage(reason, expected = {}, actual = {}) {
  if (reason === 'wrong-card') return `Studio expected ${expected.id}, but ${actual.id || 'another card'} answered. Reconnect the installed card.`;
  if (reason === 'wrong-firmware-version') return `Studio expected firmware ${expected.firmwareVersion}, but the card reports ${actual.firmwareVersion || 'no version'}.`;
  if (reason === 'wrong-firmware-build') return 'The card firmware build does not match the build verified during installation.';
  return 'Reconnect the installed card so Studio can verify its identity and firmware.';
}

export function CardCommissioningPanel({
  result = null,
  link = {},
  onReconnect,
  onComplete,
  pushProject = pushConfigToCard,
  readProjectEvidence = readCardProjectEvidence,
  readCandidateEvidence = readCardWiringCandidateEvidence,
}) {
  const { markProjectInstalled } = useProject();
  const [initialState] = useState(() => inspectCardCommissioning());
  const [flow, setFlow] = useState(initialState.flow);
  const [restoreState, setRestoreState] = useState('idle');
  const [lightCheckState, setLightCheckState] = useState('idle');
  const [lightCheckNotice, setLightCheckNotice] = useState('');
  const markerSessionRef = useRef(null);
  const markerTimeoutRef = useRef(null);
  const [failure, setFailure] = useState(initialState.error === 'corrupt'
    ? 'Saved card setup data is corrupt. Nothing was changed; restart the exact setup.'
    : initialState.error === 'invalid-lease'
      ? 'A saved card restore claim was invalid or stale and has been cleared. Verify the same card, then retry.'
    : '');

  useEffect(() => {
    const sync = () => {
      const state = inspectCardCommissioning();
      setFlow(state.flow);
      if (state.error === 'corrupt') setFailure('Saved card setup data is corrupt. Nothing was changed; restart the exact setup.');
      if (state.error === 'invalid-lease') setFailure('A saved card restore claim was invalid or stale and has been cleared. Verify the same card, then retry.');
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => () => {
    if (markerTimeoutRef.current != null) window.clearTimeout(markerTimeoutRef.current);
    markerTimeoutRef.current = null;
    const session = markerSessionRef.current;
    markerSessionRef.current = null;
    if (session) void session.stop().catch(() => {});
  }, []);

  useEffect(() => {
    if (result?.status !== 'awaiting-card-acknowledgement') return;
    void (async () => { try {
      let current = readCardCommissioning({ flowId: result.flowId });
      if (!current) throw new Error('This Bridge result has no matching saved setup in this browser profile. It was not applied; restart that exact setup.');
      if (current.source !== 'native-bridge') throw new Error('This Bridge result belongs to a different card setup attempt. Return to the setup that started it.');
      if (current.stage === 'install-safely') {
        current = completeCardInstall(current, result);
        await writeCardCommissioning(current);
      }
      setFlow(current);
      setFailure('');
    } catch (error) {
      setFailure(error?.message || 'Studio could not resume this card setup result.');
    } })();
  }, [result]);

  const cardAcknowledgement = useMemo(() => {
    if (!flow || flow.stage !== 'set-up-card') return null;
    const setupNetworkReset = ['setup-required', 'setup-joined'].includes(flow.networkState);
    const acknowledgedAt = Date.parse(link?.acknowledgedAt || '');
    const freshAfterSetupJoin = flow.networkState === 'setup-joined'
      && Number.isFinite(acknowledgedAt)
      && acknowledgedAt >= flow.updatedAt;
    if (!isCardLinkConnected(link) || (setupNetworkReset && !freshAfterSetupJoin)) return null;
    return acknowledgeCommissionedCard(flow, link?.card || {});
  }, [flow, link]);

  const interruptedInstallEvidence = useMemo(() => {
    if (!flow || flow.stage !== 'install-safely' || flow.source !== 'web-serial' || !link?.card?.id) return null;
    return resumeInstalledCardAfterInterruption(flow, link.card);
  }, [flow, link?.card]);

  useEffect(() => {
    if (!interruptedInstallEvidence?.ok) return;
    void (async () => { try {
      await writeCardCommissioning(interruptedInstallEvidence.flow);
      setFlow(interruptedInstallEvidence.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); } })();
  }, [interruptedInstallEvidence]);

  useEffect(() => {
    if (!cardAcknowledgement?.ok || flow?.cardAcknowledgedAt) return;
    void (async () => { try {
      await writeCardCommissioning(cardAcknowledgement.flow);
      setFlow(cardAcknowledgement.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); } })();
  }, [cardAcknowledgement, flow?.cardAcknowledgedAt]);

  if (!flow && lightCheckState === 'complete') return (
    <div className="card-commissioning" aria-live="polite">
      <CardCommissioningSteps stage="check-lights" />
      <h3>Light check complete</h3>
      <p>The exact temporary wiring was confirmed on the card and is now its working setup.</p>
      {onComplete && <button type="button" className="btn primary" onClick={onComplete}>Done</button>}
    </div>
  );
  if (!flow) return <div className="card-commissioning" aria-live="polite"><CardCommissioningSteps stage="connect-card" />{failure && <p className="card-connection-failure" role="alert">{failure}</p>}</div>;

  const restore = async () => {
    if (restoreState === 'working' || !flow.cardAcknowledgedAt) return;
    setRestoreState('working');
    setFailure('');
    let lease = null;
    try {
      const selectedReadback = typeof window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__ === 'function'
        ? window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__
        : readProjectEvidence;
      const priorAttempt = readCardRestorationAttempt(flow);
      if (priorAttempt) {
        try {
          const responseReadback = await selectedReadback({ host: link.host, endpoint: '/api/firmware-info', expectedCardId: flow.expectedCard.id });
          const evidence = adaptCardRestorationReadback({ method: 'GET', endpoint: '/api/firmware-info', response: responseReadback });
          const next = markCardProjectRestored(flow, evidence);
          await writeCardCommissioning(next);
          markProjectInstalled(flow.project.revision);
          setFlow(next);
          setRestoreState('complete');
          return;
        } catch {}
        if (priorAttempt.activationId) {
          try {
            const candidate = await readCandidateEvidence(priorAttempt.activationId, { host: link.host, timeoutMs: 8000 });
            const next = stageCardProjectForPhysicalCheck(flow, bindCardWiringActivationEvidence(candidate, candidate));
            await writeCardCommissioning(next);
            setFlow(next);
            setRestoreState('complete');
            return;
          } catch {}
        }
        throw new Error('A previous restore may already have reached this card, but exact independent evidence is inconclusive. Inspect or recover this setup; Studio will not send the project again automatically.');
      }
      const claim = await claimCardRestoration(flow);
      if (!claim.ok) throw new Error(claim.reason === 'restore-in-progress' ? 'This exact project restore is already running in another tab. Wait for it to finish or retry after the recovery window.' : claim.reason === 'recovery-required' ? 'A previous restore requires inspection and will not be sent again automatically.' : 'The saved setup is unavailable. Nothing was sent.');
      lease = claim.lease;
      const runtimePackage = runtimePackageFromSnapshot(flow.project.snapshot, flow.project);
      const selectedPush = typeof window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ === 'function'
        ? window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__
        : pushProject;
      const mutation = await beginCardRestorationMutation(flow, lease);
      if (!mutation.ok || !verifyCardRestorationMutation(flow, lease.id, mutation.fencingToken)) {
        throw new Error('The durable project restore claim was lost before the card mutation. Nothing was sent.');
      }
      const response = await selectedPush(runtimePackage, {
        host: link.host,
        timeoutMs: 8000,
        reboot: 'if-needed',
        allowProjectChange: true,
        allowLayoutChange: true,
      });
      await recordCardRestorationResponse(flow, lease.id, mutation.fencingToken, response);
      if (response?.state === 'staged') {
        const candidateReadback = await readCandidateEvidence(response.activationId, { host: link.host, timeoutMs: 8000 });
        const activationEvidence = bindCardWiringActivationEvidence(response, candidateReadback);
        const next = stageCardProjectForPhysicalCheck(flow, activationEvidence);
        await writeCardCommissioning(next);
        setFlow(next);
        setRestoreState('complete');
        return;
      }
      if (typeof selectedReadback !== 'function') {
        throw new Error('The project was sent, but this firmware does not yet provide independent restoration read-back. Studio has not marked it restored.');
      }
      const responseReadback = await selectedReadback({
        host: link.host,
        endpoint: '/api/firmware-info',
        expectedCardId: flow.expectedCard.id,
      });
      const evidence = adaptCardRestorationReadback({
        method: 'GET', endpoint: '/api/firmware-info', response: responseReadback,
      });
      const next = markCardProjectRestored(flow, evidence);
      await writeCardCommissioning(next);
      markProjectInstalled(flow.project.revision);
      setFlow(next);
      setRestoreState('complete');
    } catch (error) {
      setFailure(error?.message || 'Studio could not restore the saved project. Reconnect the same card and try again.');
      setRestoreState('idle');
    } finally {
      if (lease) await releaseCardRestoration(flow.flowId, lease.id).catch(() => false);
    }
  };

  const reconnecting = link?.state === 'connecting' || link?.state === 'reconnecting-bridge';
  const currentCard = link?.card || {};
  const identityFailure = flow.stage === 'set-up-card' && !flow.cardAcknowledgedAt && cardAcknowledgement && !cardAcknowledgement.ok
    ? identityMessage(cardAcknowledgement.reason, flow.expectedCard, currentCard)
    : '';

  const confirmSetupNetwork = async () => {
    setFailure('');
    try {
      const next = confirmCardSetupNetworkJoined(flow);
      await writeCardCommissioning(next);
      setFlow(next);
    } catch (error) {
      setFailure(error?.message || 'Studio could not save the Wi-Fi handoff. Try again before leaving this network.');
    }
  };

  const startLightCheck = async () => {
    const activationId = flow.project.pendingActivationId;
    if (lightCheckState !== 'idle') return;
    setFailure('');
    setLightCheckNotice('');
    setLightCheckState('starting');
    try {
      if (!activationId) {
        const frame = commissioningMarkerFrame(flow.project.snapshot);
        if (!frame.length) throw new Error('The saved project has no LED outputs to test.');
        const startMarkers = window.__LW_START_COMMISSIONING_MARKERS_FOR_TEST__;
        const session = typeof startMarkers === 'function'
          ? await startMarkers(frame, { host: link.host })
          : createWiringChaseSession({ host: link.host });
        markerSessionRef.current = session;
        if (typeof startMarkers !== 'function') await session.show(frame);
        markerTimeoutRef.current = window.setTimeout(() => {
          const active = markerSessionRef.current;
          markerSessionRef.current = null;
          markerTimeoutRef.current = null;
          void active?.stop?.().catch(() => {});
          setLightCheckState('idle');
          setLightCheckNotice('The 30-second marker test ended and the working look is restored.');
        }, 30_000);
        setLightCheckState('testing');
        return;
      }
      const activate = typeof window.__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
        ? window.__LW_ACTIVATE_COMMISSIONING_WIRING_FOR_TEST__
        : activateAndWaitForCardWiring;
      const status = await activate(activationId, { host: link.host, timeoutMs: 18000 });
      if (status?.state !== 'testing' || status?.activationId !== activationId) {
        throw new Error('The card did not start the exact temporary wiring test.');
      }
      setLightCheckState('testing');
    } catch (error) {
      const session = markerSessionRef.current;
      markerSessionRef.current = null;
      if (session) await session.stop().catch(() => {});
      setFailure(error?.message || 'The bounded light test did not start. The previous working setup remains protected.');
      setLightCheckState('idle');
    }
  };

  const finishLightCheck = async visible => {
    const activationId = flow.project.pendingActivationId;
    if (lightCheckState !== 'testing') return;
    setFailure('');
    setLightCheckNotice('');
    setLightCheckState(visible ? 'confirming' : 'restoring');
    try {
      if (!activationId) {
        if (markerTimeoutRef.current != null) window.clearTimeout(markerTimeoutRef.current);
        markerTimeoutRef.current = null;
        const session = markerSessionRef.current;
        markerSessionRef.current = null;
        await session?.stop?.();
        if (visible) {
          await clearCardCommissioning({ flowId: flow.flowId });
          setLightCheckState('complete');
        } else {
          setLightCheckState('idle');
          setLightCheckNotice('The bounded marker test stopped and the working look is restored.');
        }
        return;
      }
      if (visible) {
        const confirm = typeof window.__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_CONFIRM_COMMISSIONING_WIRING_FOR_TEST__
          : confirmCardWiringCandidate;
        const status = await confirm(activationId, { host: link.host });
        if (status?.state !== 'known-good' || (status?.activationId && status.activationId !== activationId)) {
          throw new Error('The card did not confirm the exact temporary wiring.');
        }
        await clearCardCommissioning({ flowId: flow.flowId });
        setLightCheckState('complete');
      } else {
        const rollback = typeof window.__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__ === 'function'
          ? window.__LW_ROLLBACK_COMMISSIONING_WIRING_FOR_TEST__
          : rollbackCardWiringCandidate;
        const status = await rollback(activationId, { host: link.host });
        if (status?.state !== 'known-good' || (status?.activationId && status.activationId !== activationId)) {
          throw new Error('The card did not restore the previous working wiring.');
        }
        const next = returnCardProjectToSetupAfterLightCheck(flow);
        await writeCardCommissioning(next);
        setFlow(next);
        setLightCheckState('idle');
      }
    } catch (error) {
      setFailure(error?.message || 'The card could not finish the wiring check. It will restore the previous setup when the test window ends.');
      setLightCheckState('testing');
    }
  };

  return (
    <div className="card-commissioning" data-stage={flow.stage} aria-live="polite">
      <CardCommissioningSteps stage={flow.stage} />
      {flow.stage === 'install-safely' && (
        <>
          <h3>Install safely</h3>
          <p>{flow.source === 'web-serial'
            ? 'The browser was interrupted before it recorded the result. Reconnect the card; Studio will inspect the exact card and firmware build before deciding what to do. It will not flash again automatically.'
            : 'Lightweaver is verifying the official firmware and keeping your saved Studio project available for restoration.'}</p>
          {flow.source === 'web-serial' && <button type="button" className="btn primary" onClick={onReconnect}>Reconnect and inspect card</button>}
          {interruptedInstallEvidence && !interruptedInstallEvidence.ok && link?.card?.id && <p className="card-connection-failure" role="alert">{identityMessage(interruptedInstallEvidence.reason, flow.installTarget, link.card)} Nothing was changed.</p>}
        </>
      )}
      {flow.stage === 'set-up-card' && (
        <>
          <h3>Set up card</h3>
          {flow.networkState === 'setup-required' && (
            <div className="card-commissioning-network">
              <p>The clean installation reset Wi-Fi. First open this device’s Wi-Fi settings and join <strong>Lightweaver-XXXX</strong>. The setup address only works while that network is joined.</p>
              <button type="button" className="btn primary" onClick={confirmSetupNetwork}>I’ve joined Lightweaver-XXXX</button>
            </div>
          )}
          {flow.networkState === 'setup-joined' && (
            <div className="card-commissioning-network">
              <p><strong>Lightweaver-XXXX joined.</strong> Now open the card at 192.168.4.1, choose its permanent Wi-Fi, and return here. This progress stays saved while networks change.</p>
              <a className="btn primary" href="http://192.168.4.1" target="_blank" rel="noopener noreferrer">Open 192.168.4.1 Wi-Fi setup</a>
            </div>
          )}
          {!flow.cardAcknowledgedAt ? (
            <>
              <p>{identityFailure || 'Reconnect the installed card. Studio will continue only when the exact card, firmware version, and firmware build answer.'}</p>
              <button type="button" className="btn primary" onClick={onReconnect} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Reconnect installed card'}</button>
            </>
          ) : (
            <>
              <p>The exact installed card and firmware build are verified. Restore the saved Studio revision that contains its GPIO outputs, LED map, zones, patterns, playlist, and controls.</p>
              <button type="button" className="btn primary" onClick={restore} disabled={restoreState === 'working'}>{restoreState === 'working' ? 'Restoring saved project…' : 'Restore saved project'}</button>
            </>
          )}
        </>
      )}
      {flow.stage === 'check-lights' && (
        <>
          <h3>Check lights</h3>
          <p>{flow.project.pendingActivationId
            ? 'The saved Studio project revision is staged on this exact card. The bounded physical light check will test its GPIO wiring before making it permanent.'
            : 'The saved Studio project revision is installed on this exact card. Continue to the bounded physical light check.'}</p>
          {flow.project.pendingActivationId ? (
            <div className="card-commissioning-network">
              {lightCheckState === 'testing' ? (
                <>
                  <p>Check every connected output. Do you see a <strong>blue first pixel and red final pixel</strong>, with the expected LEDs between them?</p>
                  <div className="card-connection-actions">
                    <button type="button" className="btn primary" onClick={() => finishLightCheck(true)}>Yes, every output is correct</button>
                    <button type="button" className="btn" onClick={() => finishLightCheck(false)}>No, restore working setup</button>
                  </div>
                </>
              ) : (
                <>
                  <p>The test lasts at most 90 seconds. Until you confirm the real LEDs, the card keeps the previous working wiring ready to restore automatically.</p>
                  <button type="button" className="btn primary" disabled={lightCheckState !== 'idle'} onClick={startLightCheck}>{lightCheckState === 'starting' ? 'Starting bounded light test…' : 'Start 90-second light test'}</button>
                </>
              )}
            </div>
          ) : (
            <div className="card-commissioning-network">
              {lightCheckState === 'testing' ? (
                <>
                  <p>Check every connected output. Do you see a <strong>blue first pixel and red final pixel</strong>, with green LEDs between them?</p>
                  <div className="card-connection-actions">
                    <button type="button" className="btn primary" onClick={() => finishLightCheck(true)}>Yes, every output is correct</button>
                    <button type="button" className="btn" onClick={() => finishLightCheck(false)}>No, restore working look</button>
                  </div>
                </>
              ) : (
                <>
                  <p>This marker frame runs for at most 30 seconds, then releases the card back to its normal working look automatically.</p>
                  <button type="button" className="btn primary" disabled={lightCheckState !== 'idle'} onClick={startLightCheck}>{lightCheckState === 'starting' ? 'Starting bounded marker test…' : 'Start bounded marker test'}</button>
                </>
              )}
              {lightCheckNotice && <p role="status">{lightCheckNotice}</p>}
            </div>
          )}
        </>
      )}
      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}
    </div>
  );
}

export { runtimePackageFromSnapshot };
