import { useReducer, useRef, useState } from 'react';
import { useProject } from '../../../state/ProjectContext.jsx';
import { cardActionReducer, createCardActionState } from '../../../lib/cardAction.js';
import {
  makeCardRuntimePackage,
  patchBoardToZones,
} from '../../../lib/cardRuntimeContract.js';
import { chainAddressCount } from '../../../lib/patchBoard.js';
import {
  getCardHostname,
  setCardHostname,
  pushConfigToCard,
  buildCardConfigHandoffUrl,
  CardPushError,
} from '../../../lib/cardPushClient.js';
import {
  activateAndWaitForCardWiring,
  confirmCardWiringCandidate,
  rollbackCardWiringCandidate,
} from '../../../lib/cardWiringSafety.js';

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
  const pushToCard = async (retryAttempt = null) => {
    const cleanHost = retryAttempt?.host || pushHost.trim().toLowerCase() || 'lightweaver.local';
    setCardHostname(cleanHost);
    setPushHost(getCardHostname());
    const attempt = retryAttempt || (() => {
      const zones = patchBoardToZones(board, strips);
      const outputs = (standaloneController?.outputs || []).map((o, i) => ({ id: o.id || `out${i + 1}`, name: o.name || `Output ${i + 1}`, pin: o.pin, pixels: o.pixels }));
      const totalPixels = chainAddressCount(board, strips);
      return {
        host: cleanHost,
        revision: projectLifecycle.editedRevision,
        zoneCount: zones.length,
        pkg: makeCardRuntimePackage({
          projectId, projectName, mode: 'website-flash',
          led: { pixels: totalPixels || undefined, colorOrder: standaloneController?.led?.colorOrder, brightnessLimit: standaloneController?.led?.brightnessLimit, outputs: outputs.length ? outputs : undefined },
          controls: standaloneController?.controls, zones, syncZones: zones.length <= 1,
        }),
      };
    })();
    setWiringTestState('idle');
    setWiringCandidate(null);
    dispatchAction({ type: 'start', revision: attempt.revision });
    setPushStatus(`Pushing revision ${attempt.revision} to ${cleanHost}...`);
    setPushFallbackJson(''); setPushFallbackPackage(null);
    try {
      const response = await pushConfigToCard(attempt.pkg, { host: attempt.host, allowLayoutChange: true });
      if (response?.state === 'staged' && response.activationId) {
        setWiringCandidate({ activationId: response.activationId, attempt });
        setWiringTestState('staged');
        failedAttemptRef.current = null;
        setPushStatus('New wiring is ready to test. Your current working setup is still safe.');
        return;
      }
      dispatchAction({ type: 'confirm' });
      markProjectInstalled(attempt.revision);
      markCardLookConfirmed({ ...(standaloneController?.defaultLook || {}), syncZones: true });
      failedAttemptRef.current = null;
      setPushStatus(`Saved revision ${attempt.revision} to card · ${attempt.zoneCount} zone${attempt.zoneCount === 1 ? '' : 's'} at ${cleanHost}`);
    } catch (err) {
      failedAttemptRef.current = attempt;
      const message = err instanceof CardPushError ? err.message : `Push failed: ${err.message || err}`;
      dispatchAction({ type: 'fail', error: message });
      if (err instanceof CardPushError && err.reason === 'mixed-content') {
        setPushStatus('Browser blocked the request. Use the JSON below: connect to the card and paste at its onboard page.');
        setPushFallbackJson(JSON.stringify(attempt.pkg.config, null, 2));
        setPushFallbackPackage(attempt.pkg);
      } else if (err instanceof CardPushError) {
        setPushStatus(err.message);
      } else {
        setPushStatus(`Push failed: ${err.message || err}`);
      }
    }
  };

  const startWiringTest = async () => {
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
  };

  const finishWiringTest = async visible => {
    if (!wiringCandidate) return;
    setWiringTestState(visible ? 'confirming' : 'rolling-back');
    try {
      if (visible) {
        await confirmCardWiringCandidate(wiringCandidate.activationId, { host: wiringCandidate.attempt.host });
        dispatchAction({ type: 'confirm' });
        markProjectInstalled(wiringCandidate.attempt.revision);
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
  };

  const pushing = action.status === 'pending' && wiringTestState === 'idle';
  const wiringTransactionActive = Boolean(wiringCandidate);

  return (
    <div className="la-card-push">
      <div className="la-card-push-row">
        <button
          className="btn primary la-card-push-btn"
          data-testid="layout-send-to-card"
          disabled={disabled || pushing || wiringTransactionActive}
          onClick={() => pushToCard()}
          title={connected ? `Save zones to ${pushHost}` : `Card link idle — try ${pushHost} anyway (discovery + fallback)`}
        >
          <span className={`la-card-push-dot${connected ? ' on' : ' off'}`}/>
          <span className="la-card-push-label">{pushing ? `Saving to ${pushHost}…` : 'Save to card'}<small>{connected ? 'Card connected' : 'Card not connected'}</small></span>
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
              <button className="btn" onClick={() => navigator.clipboard?.writeText(pushFallbackJson)}>Copy payload</button>
              <button className="btn" onClick={() => window.open(buildCardConfigHandoffUrl(failedAttemptRef.current?.host || getCardHostname(), pushFallbackPackage), '_blank', 'noopener')}>Open installer</button>
            </div>
          )}
          {action.status === 'failed' && <button className="btn" onClick={() => pushToCard(failedAttemptRef.current)}>Retry</button>}
        </div>
      )}
      {wiringCandidate && (
        <section className="lw-wiring-candidate" aria-label="Wiring safety check">
          <strong>{wiringTestState === 'testing' ? 'Do you see the expected lights?' : 'Test the new wiring'}</strong>
          <p>{wiringTestState === 'testing' ? 'Check every connected output. Confirm only when the real LEDs match the blue first pixel and red final pixel test.' : 'The current working wiring remains stored until this test succeeds.'}</p>
          {wiringTestState === 'staged' || wiringTestState === 'failed' ? (
            <div><button className="btn primary" onClick={startWiringTest}>Start 90-second test</button><button className="btn" onClick={() => finishWiringTest(false)}>Cancel change</button></div>
          ) : wiringTestState === 'testing' ? (
            <div><button className="btn primary" onClick={() => finishWiringTest(true)}>Yes, everything lights correctly</button><button className="btn" onClick={() => finishWiringTest(false)}>No, restore working setup</button></div>
          ) : <p>Working…</p>}
        </section>
      )}
    </div>
  );
}
