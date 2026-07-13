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
  const { projectLifecycle, markProjectInstalled } = useProject();
  const [pushHost, setPushHost] = useState(() => getCardHostname());
  const [pushStatus, setPushStatus] = useState('');
  const [action, dispatchAction] = useReducer(cardActionReducer, { confirmedRevision: projectLifecycle.installedRevision }, createCardActionState);
  const [pushFallbackJson, setPushFallbackJson] = useState('');
  const [pushFallbackPackage, setPushFallbackPackage] = useState(null);
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
    dispatchAction({ type: 'start', revision: attempt.revision });
    setPushStatus(`Pushing revision ${attempt.revision} to ${cleanHost}...`);
    setPushFallbackJson(''); setPushFallbackPackage(null);
    try {
      await pushConfigToCard(attempt.pkg, { host: attempt.host, allowLayoutChange: true });
      dispatchAction({ type: 'confirm' });
      markProjectInstalled(attempt.revision);
      failedAttemptRef.current = null;
      setPushStatus(`Installed revision ${attempt.revision} on card · ${attempt.zoneCount} zone${attempt.zoneCount === 1 ? '' : 's'} at ${cleanHost}`);
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

  const pushing = action.status === 'pending';

  return (
    <div className="la-card-push">
      <div className="la-card-push-row">
        <button
          className="btn primary la-card-push-btn"
          data-testid="layout-send-to-card"
          disabled={disabled || pushing}
          onClick={() => pushToCard()}
          title={connected ? `Push zones to ${pushHost}` : `Card link idle — try ${pushHost} anyway (discovery + fallback)`}
        >
          <span className={`la-card-push-dot${connected ? ' on' : ' off'}`}/>
          {pushing ? `Pushing to ${pushHost}…` : 'Send to card'}
        </button>
        {children}
      </div>

      {pushStatus && (
        <div className={`la-card-push-banner ${action.status === 'confirmed' ? 'is-ok' : action.status === 'failed' ? 'is-err' : 'is-pending'}`}>
          {pushStatus}
          {action.status === 'failed' && action.confirmedRevision != null && <p>Installed revision {action.confirmedRevision} remains on the card.</p>}
          {pushFallbackJson && (
            <div className="lw-wire-recovery" aria-label="Mixed-content recovery">
              <textarea readOnly value={pushFallbackJson} onClick={e => e.target.select()} className="la-card-push-fallback"/>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(pushFallbackJson)}>Copy payload</button>
              <button className="btn" onClick={() => window.open(buildCardConfigHandoffUrl(failedAttemptRef.current?.host || getCardHostname(), pushFallbackPackage), '_blank', 'noopener')}>Open installer</button>
            </div>
          )}
          {action.status === 'failed' && <button className="btn" onClick={() => pushToCard(failedAttemptRef.current)}>Retry</button>}
        </div>
      )}
    </div>
  );
}
