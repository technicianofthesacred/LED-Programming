import { useState } from 'react';
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
  const [pushHost, setPushHost] = useState(() => getCardHostname());
  const [pushStatus, setPushStatus] = useState('');
  const [pushKind, setPushKind] = useState(''); // '' | 'ok' | 'err' | 'pending'
  const [pushFallbackJson, setPushFallbackJson] = useState('');
  const [pushFallbackPackage, setPushFallbackPackage] = useState(null);

  // Serialize the current patch board into the firmware's runtime contract.
  // Direct push is only for local HTTP/file Studio sessions; hosted HTTPS
  // flows use the copy-paste fallback shown by the error state.
  const pushToCard = async () => {
    const cleanHost = pushHost.trim().toLowerCase() || 'lightweaver.local';
    setCardHostname(cleanHost);
    setPushHost(getCardHostname());
    setPushKind('pending');
    setPushStatus(`Pushing to ${cleanHost}...`);
    setPushFallbackJson('');
    setPushFallbackPackage(null);
    const zones = patchBoardToZones(board, strips);
    const outputs = (standaloneController?.outputs || []).map((o, i) => ({
      id: o.id || `out${i + 1}`,
      name: o.name || `Output ${i + 1}`,
      pin: o.pin,
      pixels: o.pixels,
    }));
    const totalPixels = chainAddressCount(board, strips);
    const pkg = makeCardRuntimePackage({
      projectId,
      projectName,
      mode: 'website-flash',
      led: {
        pixels: totalPixels || undefined,
        colorOrder: standaloneController?.led?.colorOrder,
        brightnessLimit: standaloneController?.led?.brightnessLimit,
        outputs: outputs.length ? outputs : undefined,
      },
      controls: standaloneController?.controls,
      zones,
      syncZones: zones.length <= 1,
    });
    try {
      await pushConfigToCard(pkg, { host: getCardHostname(), allowLayoutChange: true });
      setPushKind('ok');
      setPushStatus(`Pushed ${zones.length} zone${zones.length === 1 ? '' : 's'} to ${cleanHost}`);
      setTimeout(() => { setPushStatus(''); setPushKind(''); }, 4000);
    } catch (err) {
      setPushKind('err');
      if (err instanceof CardPushError && err.reason === 'mixed-content') {
        setPushStatus('Browser blocked the request. Use the JSON below: connect to the card and paste at its onboard page.');
        setPushFallbackJson(JSON.stringify(pkg.config, null, 2));
        setPushFallbackPackage(pkg);
      } else if (err instanceof CardPushError) {
        setPushStatus(err.message);
      } else {
        setPushStatus(`Push failed: ${err.message || err}`);
      }
    }
  };

  const pushing = pushKind === 'pending';

  return (
    <div className="la-card-push">
      <div className="la-card-push-row">
        <button
          className="btn primary la-card-push-btn"
          data-testid="layout-send-to-card"
          disabled={disabled || pushing}
          onClick={pushToCard}
          title={connected ? `Push zones to ${pushHost}` : `Card link idle — try ${pushHost} anyway (discovery + fallback)`}
        >
          <span className={`la-card-push-dot${connected ? ' on' : ' off'}`}/>
          {pushing ? `Pushing to ${pushHost}…` : 'Send to card'}
        </button>
        {children}
      </div>

      {pushStatus && (
        <div className={`la-card-push-banner ${pushKind === 'ok' ? 'is-ok' : pushKind === 'err' ? 'is-err' : 'is-pending'}`}>
          {pushStatus}
          {pushFallbackJson && (
            <div className="lw-wire-recovery" aria-label="Mixed-content recovery">
              <textarea readOnly value={pushFallbackJson} onClick={e => e.target.select()} className="la-card-push-fallback"/>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(pushFallbackJson)}>Copy payload</button>
              <button className="btn" onClick={() => window.open(buildCardConfigHandoffUrl(getCardHostname(), pushFallbackPackage), '_blank', 'noopener')}>Open installer</button>
              <button className="btn" onClick={pushToCard}>Retry</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
