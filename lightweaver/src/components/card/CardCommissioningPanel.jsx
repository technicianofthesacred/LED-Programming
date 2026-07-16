import React, { useEffect, useMemo, useState } from 'react';
import { useProject } from '../../state/ProjectContext.jsx';
import { buildCardRuntimePackageFromProject } from '../../lib/cardRuntimeProject.js';
import { pushConfigToCard, readCardProjectEvidence } from '../../lib/cardPushClient.js';
import { readCardWiringCandidateEvidence } from '../../lib/cardWiringSafety.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  CARD_COMMISSIONING_STAGES,
  adaptCardRestorationReadback,
  acknowledgeCommissionedCard,
  bindCardWiringActivationEvidence,
  claimCardRestoration,
  completeCardInstall,
  markCardProjectRestored,
  readCardCommissioning,
  inspectCardCommissioning,
  releaseCardRestoration,
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

function runtimePackageFromSnapshot(snapshot = {}) {
  return buildCardRuntimePackageFromProject({
    projectId: snapshot.id,
    projectName: snapshot.name,
    strips: snapshot.layout?.strips || [],
    patchBoard: snapshot.layout?.patchBoard || null,
    wiring: snapshot.layout?.wiring || null,
    standaloneController: snapshot.devices?.standaloneController || {},
  });
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
  const [failure, setFailure] = useState(initialState.error === 'corrupt'
    ? 'Saved card setup data is corrupt. Nothing was changed; restart the exact setup.'
    : '');

  useEffect(() => {
    const sync = () => {
      const state = inspectCardCommissioning();
      setFlow(state.flow);
      if (state.error === 'corrupt') setFailure('Saved card setup data is corrupt. Nothing was changed; restart the exact setup.');
    };
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    if (result?.status !== 'awaiting-card-acknowledgement') return;
    try {
      let current = readCardCommissioning({ flowId: result.flowId });
      if (!current) throw new Error('This Bridge result has no matching saved setup in this browser profile. It was not applied; restart that exact setup.');
      if (current.source !== 'native-bridge') throw new Error('This Bridge result belongs to a different card setup attempt. Return to the setup that started it.');
      if (current.stage === 'install-safely') {
        current = completeCardInstall(current, result);
        writeCardCommissioning(current);
      }
      setFlow(current);
      setFailure('');
    } catch (error) {
      setFailure(error?.message || 'Studio could not resume this card setup result.');
    }
  }, [result]);

  const cardAcknowledgement = useMemo(() => {
    if (!flow || flow.stage !== 'set-up-card') return null;
    return acknowledgeCommissionedCard(flow, link?.card || {});
  }, [flow, link?.card]);

  const interruptedInstallEvidence = useMemo(() => {
    if (!flow || flow.stage !== 'install-safely' || flow.source !== 'web-serial' || !link?.card?.id) return null;
    return resumeInstalledCardAfterInterruption(flow, link.card);
  }, [flow, link?.card]);

  useEffect(() => {
    if (!interruptedInstallEvidence?.ok) return;
    try {
      writeCardCommissioning(interruptedInstallEvidence.flow);
      setFlow(interruptedInstallEvidence.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); }
  }, [interruptedInstallEvidence]);

  useEffect(() => {
    if (!cardAcknowledgement?.ok || flow?.cardAcknowledgedAt) return;
    try {
      writeCardCommissioning(cardAcknowledgement.flow);
      setFlow(cardAcknowledgement.flow);
    } catch (error) { setFailure(`Card setup could not be saved: ${error?.message || String(error)}`); }
  }, [cardAcknowledgement, flow?.cardAcknowledgedAt]);

  if (!flow) return <div className="card-commissioning" aria-live="polite"><CardCommissioningSteps stage="connect-card" />{failure && <p className="card-connection-failure" role="alert">{failure}</p>}</div>;

  const restore = async () => {
    if (restoreState === 'working' || !flow.cardAcknowledgedAt) return;
    setRestoreState('working');
    setFailure('');
    let lease = null;
    try {
      const claim = claimCardRestoration(flow);
      if (!claim.ok) throw new Error(claim.reason === 'restore-in-progress' ? 'This exact project restore is already running in another tab. Wait for it to finish or retry after the recovery window.' : 'The saved setup is unavailable. Nothing was sent.');
      lease = claim.lease;
      const runtimePackage = runtimePackageFromSnapshot(flow.project.snapshot);
      const selectedPush = typeof window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__ === 'function'
        ? window.__LW_PUSH_COMMISSIONING_PROJECT_FOR_TEST__
        : pushProject;
      const response = await selectedPush(runtimePackage, {
        host: link.host,
        timeoutMs: 8000,
        reboot: 'if-needed',
        allowProjectChange: true,
        allowLayoutChange: true,
      });
      const selectedReadback = typeof window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__ === 'function'
        ? window.__LW_READ_COMMISSIONING_EVIDENCE_FOR_TEST__
        : readProjectEvidence;
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
      if (response?.state === 'staged') {
        const candidateReadback = await readCandidateEvidence(response.activationId, { host: link.host, timeoutMs: 8000 });
        const activationEvidence = bindCardWiringActivationEvidence(response, candidateReadback);
        const next = stageCardProjectForPhysicalCheck(flow, activationEvidence);
        writeCardCommissioning(next);
        setFlow(next);
        setRestoreState('complete');
        return;
      }
      const next = markCardProjectRestored(flow, evidence);
      writeCardCommissioning(next);
      markProjectInstalled(flow.project.revision);
      setFlow(next);
      setRestoreState('complete');
    } catch (error) {
      setFailure(error?.message || 'Studio could not restore the saved project. Reconnect the same card and try again.');
      setRestoreState('idle');
    } finally {
      if (lease) releaseCardRestoration(flow.flowId, lease.id);
    }
  };

  const reconnecting = link?.state === 'connecting' || link?.state === 'reconnecting-bridge';
  const currentCard = link?.card || {};
  const identityFailure = flow.stage === 'set-up-card' && !flow.cardAcknowledgedAt && cardAcknowledgement && !cardAcknowledgement.ok
    ? identityMessage(cardAcknowledgement.reason, flow.expectedCard, currentCard)
    : '';

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
              <p>The clean installation reset Wi-Fi. Join <strong>Lightweaver-XXXX</strong>, finish Wi-Fi setup, then return here. This progress stays saved while networks change.</p>
              <a className="btn" href="http://192.168.4.1" target="_blank" rel="noopener noreferrer">Open card Wi-Fi setup</a>
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
          {onComplete && <button type="button" className="btn primary" onClick={onComplete}>Continue to light check</button>}
        </>
      )}
      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}
    </div>
  );
}

export { runtimePackageFromSnapshot };
