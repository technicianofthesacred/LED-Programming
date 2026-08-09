import { useReducer, useRef, useState } from 'react';
import { useProject } from '../../../state/ProjectContext.jsx';
import { cardActionReducer, createCardActionState } from '../../../lib/cardAction.js';
import {
  getCardHostname,
  setCardHostname,
  pushConfigToCard,
  readCardProjectEvidence,
  readCardStatusEnvelope,
  buildCardConfigHandoffUrl,
  CardPushError,
} from '../../../lib/cardPushClient.js';
import {
  prepareCardDeployment,
  cardStatusAsConfig,
  assertCardDeploymentPreflightIdentity,
  correlateCardDeploymentReadinessEvidence,
  orchestrateCardDeploymentStart,
  waitForCardDeploymentVerification,
} from '../../../lib/cardDeployment.js';
import {
  activateAndWaitForCardWiring,
  confirmCardWiringCandidate,
  getCardWiringStatus,
  rollbackCardWiringCandidate,
} from '../../../lib/cardWiringSafety.js';
import { openLocalCardPage } from '../../../lib/cardBridge.js';
import { readPersistedCardIdentity } from '../../../lib/cardIdentity.js';
import { prepareCardStoragePayload } from '../../../lib/cardStoragePayload.js';
import { withStudioHardwareOperation } from '../../../lib/studioHardwareOperation.js';

const LOCAL_BRIDGE_RECOVERY_REASONS = new Set([
  'mixed-content',
  'bridge-missing',
  'bridge-timeout',
  'bridge-post-failed',
]);

async function readReadyDeploymentEvidence(host) {
  const [project, status] = await Promise.all([
    readCardProjectEvidence({ host }),
    readCardStatusEnvelope({ host }),
  ]);
  return correlateCardDeploymentReadinessEvidence(project, status);
}

// Send-to-card control (Wire mode, Phase 2 step 9 / plan Phase 3). Extracted
// from PatchBoardScreen.pushToCard + its push* state. The `connected` prop
// drives the ambient status dot (grey when disconnected, green when the card
// link is live) but never disables the button — pushConfigToCard runs its own
// discovery/fallback, so a push is worth attempting even when the ambient link
// reads disconnected. `children` render next to the Send button (Wire mode
// slots the Export ledmap.json button in there).
export function CardPushControl({
  connected,
  board,
  strips,
  projectId,
  projectName,
  standaloneController,
  disabled = false,
  children,
}) {
  const { projectLifecycle, markProjectInstalled, markCardLookConfirmed } = useProject();
  const [pushHost, setPushHost] = useState(() => getCardHostname());
  const [pushStatus, setPushStatus] = useState('');
  const [action, dispatchAction] = useReducer(cardActionReducer, { confirmedRevision: projectLifecycle.installedRevision }, createCardActionState);
  const [pushFallbackJson, setPushFallbackJson] = useState('');
  const [pushFallbackPackage, setPushFallbackPackage] = useState(null);
  const [wiringCandidate, setWiringCandidate] = useState(null);
  const [wiringTestState, setWiringTestState] = useState('idle');
  const failedAttemptRef = useRef(null);

  // Serialize the current patch board into the firmware's runtime contract.
  // Direct push is only for local HTTP/file Studio sessions; hosted HTTPS
  // flows use the copy-paste fallback shown by the error state.
  const pushToCard = async (retryAttempt = null) => withStudioHardwareOperation('install-project', async () => {
    const cleanHost = retryAttempt?.host || pushHost.trim().toLowerCase() || 'lightweaver.local';
    setCardHostname(cleanHost);
    setPushHost(getCardHostname());
    let attempt = retryAttempt;
    setWiringTestState('idle');
    setWiringCandidate(null);
    setPushFallbackJson(''); setPushFallbackPackage(null);
    try {
      if (!attempt) {
        const project = {
          projectId,
          projectName,
          projectRevision: projectLifecycle.editedRevision,
          strips,
          patchBoard: board,
          standaloneController,
        };
        prepareCardStoragePayload(prepareCardDeployment(project).runtimePackage);
        let before;
        let status;
        let wiringStatus;
        let handoffOnly = false;
        try {
          [before, status, wiringStatus] = await Promise.all([
            readCardProjectEvidence({ host: cleanHost }),
            readCardStatusEnvelope({ host: cleanHost }),
            getCardWiringStatus({ host: cleanHost }),
          ]);
          assertCardDeploymentPreflightIdentity(before, status);
        } catch (preflightError) {
          if (!LOCAL_BRIDGE_RECOVERY_REASONS.has(preflightError?.reason)) throw preflightError;
          const rememberedCard = readPersistedCardIdentity();
          if (!rememberedCard?.id) {
            throw new CardPushError('identity-missing', 'Pair this Lightweaver card before creating an installer handoff.');
          }
          // A hosted HTTPS Studio cannot independently read local HTTP state
          // without its card tab. Build a bounded handoff for the exact paired
          // card, but do not mark it installed until later read-back succeeds.
          before = { cardId: rememberedCard.id };
          status = {};
          wiringStatus = null;
          handoffOnly = true;
        }
        const prepared = prepareCardDeployment(project, {
          cardId: before.cardId,
          buildId: before.buildId,
          activationId: wiringStatus?.activationId,
          previousConfig: cardStatusAsConfig(status),
        });
        attempt = {
          host: cleanHost,
          revision: projectLifecycle.editedRevision,
          generation: projectLifecycle.generation,
          zoneCount: prepared.config.zones.length,
          pkg: prepared.runtimePackage,
          prepared,
          handoffOnly,
        };
      }
      dispatchAction({ type: 'start', revision: attempt.revision });
      if (attempt.handoffOnly) {
        throw new CardPushError('bridge-missing', 'Open the paired card installer to continue. Nothing was sent.');
      }
      const deploymentStart = await orchestrateCardDeploymentStart(
        attempt.prepared,
        {
          readFirmwareInfo: () => readCardProjectEvidence({ host: attempt.host }),
          readStatus: () => readCardStatusEnvelope({ host: attempt.host }),
          readWiringStatus: () => getCardWiringStatus({ host: attempt.host }),
          config: async () => {
            setPushStatus(`Sending revision ${attempt.revision} to ${cleanHost}...`);
            return pushConfigToCard(attempt.pkg, { host: attempt.host, allowLayoutChange: true });
          },
        },
      );
      attempt = { ...attempt, wiringStatus: deploymentStart.status, resumeAction: deploymentStart.action };
      if (attempt.resumeAction === 'candidate-conflict') {
        throw new CardPushError(
          'candidate-conflict',
          'This card already has a different staged installation. Roll back that candidate or intentionally replace it, then retry. Nothing was sent.',
        );
      }
      if (attempt.resumeAction !== 'stage-new') {
        setWiringCandidate({ activationId: attempt.wiringStatus.activationId, attempt });
        if (attempt.resumeAction === 'resume-activation') {
          setWiringTestState('staged');
          setPushStatus('This exact wiring installation is already staged. Continue with its light test; nothing was sent again.');
        } else if (attempt.resumeAction === 'resume-physical-test' || attempt.resumeAction === 'resume-confirmation') {
          setWiringTestState('testing');
          setPushStatus('This exact wiring installation is already in its physical test. Confirm it only after checking the real LEDs.');
        }
        failedAttemptRef.current = null;
        return;
      }
      const response = deploymentStart.response;
      if (response?.state === 'staged' && response.activationId) {
        setWiringCandidate({ activationId: response.activationId, attempt });
        setWiringTestState('staged');
        failedAttemptRef.current = null;
        setPushStatus('New wiring is ready to test. Your current working setup is still safe.');
        return;
      }
      setPushStatus('Verifying the exact project on the card…');
      const verification = await waitForCardDeploymentVerification(attempt.prepared, {
        readEvidence: () => readReadyDeploymentEvidence(attempt.host),
        requireReady: true,
      });
      dispatchAction({ type: 'confirm' });
      markProjectInstalled({
        revision: attempt.revision,
        generation: attempt.generation,
        cardId: verification.cardId,
        projectRevision: attempt.prepared.config.projectRevision,
        projectFingerprint: attempt.prepared.config.projectFingerprint,
      });
      markCardLookConfirmed({ ...(standaloneController?.defaultLook || {}), syncZones: true });
      failedAttemptRef.current = null;
      setPushStatus(`Installed revision ${attempt.revision} on card · ${attempt.zoneCount} zone${attempt.zoneCount === 1 ? '' : 's'} at ${cleanHost}`);
    } catch (err) {
      failedAttemptRef.current = attempt;
      const message = err instanceof CardPushError ? err.message : `Push failed: ${err.message || err}`;
      dispatchAction({ type: 'fail', error: message });
      if (attempt?.pkg && LOCAL_BRIDGE_RECOVERY_REASONS.has(err?.reason)) {
        setPushStatus('Browser blocked the request. Use the JSON below: connect to the card and paste at its onboard page.');
        setPushFallbackJson(JSON.stringify(attempt.pkg.config, null, 2));
        setPushFallbackPackage(attempt.pkg);
      } else if (err instanceof CardPushError) {
        setPushStatus(err.message);
      } else {
        setPushStatus(`Push failed: ${err.message || err}`);
      }
    }
  });

  const startWiringTest = async () => withStudioHardwareOperation('activate-wiring', async () => {
    if (!wiringCandidate) return;
    setWiringTestState('starting');
    setPushStatus('Restarting the card with the test wiring…');
    try {
      await activateAndWaitForCardWiring(wiringCandidate.activationId, {
        host: wiringCandidate.attempt.host,
        timeoutMs: 18000,
      });
      setWiringTestState('testing');
      setPushStatus('Testing the new wiring. The card will restore the working setup automatically if you do not confirm it.');
    } catch (error) {
      setWiringTestState('failed');
      setPushStatus(error.message || 'The test wiring did not start. The working setup remains safe.');
    }
  });

  const finishWiringTest = async visible => withStudioHardwareOperation('finish-wiring', async () => {
    if (!wiringCandidate) return;
    setWiringTestState(visible ? 'confirming' : 'rolling-back');
    try {
      if (visible) {
        await confirmCardWiringCandidate(wiringCandidate.activationId, { host: wiringCandidate.attempt.host });
        setPushStatus('Verifying the confirmed wiring on the card…');
        const verification = await waitForCardDeploymentVerification(wiringCandidate.attempt.prepared, {
          readEvidence: () => readReadyDeploymentEvidence(wiringCandidate.attempt.host),
          requireReady: true,
        });
        dispatchAction({ type: 'confirm' });
        markProjectInstalled({
          revision: wiringCandidate.attempt.revision,
          generation: wiringCandidate.attempt.generation,
          cardId: verification.cardId,
          projectRevision: wiringCandidate.attempt.prepared.config.projectRevision,
          projectFingerprint: wiringCandidate.attempt.prepared.config.projectFingerprint,
        });
        markCardLookConfirmed({ ...(standaloneController?.defaultLook || {}), syncZones: true });
        setPushStatus(`Wiring confirmed. Revision ${wiringCandidate.attempt.revision} is now the card’s working setup.`);
        setWiringTestState('confirmed');
      } else {
        await rollbackCardWiringCandidate(wiringCandidate.activationId, { host: wiringCandidate.attempt.host });
        failedAttemptRef.current = wiringCandidate.attempt;
        dispatchAction({ type: 'fail', error: 'Wiring test rolled back.' });
        setPushStatus('Restored the last working setup. Use Find my LED wire before trying again.');
        setWiringTestState('rolled-back');
      }
      setWiringCandidate(null);
    } catch (error) {
      setWiringTestState('failed');
      setPushStatus(error.message || 'The card could not finish the wiring test. It will roll back automatically when the timer ends.');
    }
  });

  const pushing = action.status === 'pending' && wiringTestState === 'idle';
  const wiringTransactionActive = Boolean(wiringCandidate);
  const openInstaller = () => {
    const host = failedAttemptRef.current?.host || getCardHostname();
    const url = new URL(buildCardConfigHandoffUrl(host, pushFallbackPackage));
    openLocalCardPage(host, {
      path: `${url.pathname}${url.search}${url.hash}`,
      reason: 'card-installer',
    });
  };

  return (
    <div className="la-card-push">
      <div className="la-card-push-row">
        <button
          className="btn primary la-card-push-btn"
          data-testid="layout-send-to-card"
          disabled={disabled || pushing || wiringTransactionActive}
          onClick={() => pushToCard()}
          title="Send this verified project to the card, replacing its active project after card verification."
          data-tooltip="Send this verified project to the card, replacing its active project after card verification."
        >
          <span className={`la-card-push-dot${connected ? ' on' : ' off'}`}/>
          <span className="la-card-push-label">{pushing ? `Sending to ${pushHost}…` : 'Install on card'}<small>{connected ? 'Ready to install' : 'Connect the card first'}</small></span>
        </button>
        {children}
      </div>

      {pushStatus && (
        <div className={`la-card-push-banner ${action.status === 'confirmed' ? 'is-ok' : action.status === 'failed' ? 'is-err' : 'is-pending'}`}>
          {pushStatus}
          {action.status === 'failed' && action.confirmedRevision != null && <p>Confirmed revision {action.confirmedRevision} remains on the card.</p>}
          {pushFallbackJson && (
            <div className="lw-wire-recovery" role="group" aria-label="Mixed-content recovery">
              <textarea readOnly value={pushFallbackJson} onClick={e => e.target.select()} className="la-card-push-fallback"/>
              <button className="btn" title="Copy the installer JSON so it can be pasted into the card's onboard page." data-tooltip="Copy the installer JSON so it can be pasted into the card's onboard page." onClick={() => navigator.clipboard?.writeText(pushFallbackJson)}>Copy payload</button>
              <button className="btn" title="Open the paired card's local installer with this project ready to apply." data-tooltip="Open the paired card's local installer with this project ready to apply." onClick={openInstaller}>Open installer</button>
            </div>
          )}
          {action.status === 'failed' && <button className="btn" title="Try the failed card installation again using the same prepared project." data-tooltip="Try the failed card installation again using the same prepared project." onClick={() => pushToCard(failedAttemptRef.current)}>Retry</button>}
        </div>
      )}
      {wiringCandidate && (
        <section className="lw-wiring-candidate" aria-label="Wiring safety check">
          <strong>{wiringTestState === 'testing' ? 'Do you see the expected lights?' : 'Test the new wiring'}</strong>
          <p>{wiringTestState === 'testing' ? 'Check every connected output. Confirm only when the real LEDs match the blue first pixel and red final pixel test.' : 'The current working wiring remains stored until this test succeeds.'}</p>
          {wiringTestState === 'staged' || wiringTestState === 'failed' ? (
            <div><button className="btn primary" title="Restart the card using the staged wiring so you can check the real LEDs before committing it." data-tooltip="Restart the card using the staged wiring so you can check the real LEDs before committing it." onClick={startWiringTest}>Start light test</button><button className="btn" title="Discard the staged wiring change and keep the card's last working setup." data-tooltip="Discard the staged wiring change and keep the card's last working setup." onClick={() => finishWiringTest(false)}>Cancel change</button></div>
          ) : wiringTestState === 'testing' ? (
            <div><button className="btn primary" title="Confirm the real light test passed and make this wiring the card's working setup." data-tooltip="Confirm the real light test passed and make this wiring the card's working setup." onClick={() => finishWiringTest(true)}>The lights look correct</button><button className="btn" title="Reject the tested wiring and restore the card's last working setup." data-tooltip="Reject the tested wiring and restore the card's last working setup." onClick={() => finishWiringTest(false)}>No, restore working setup</button></div>
          ) : <p>Working…</p>}
        </section>
      )}
    </div>
  );
}
