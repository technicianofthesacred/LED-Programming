import { useState } from 'react';
import {
  makeCardRuntimePackage,
  patchBoardToZones,
} from '../../../lib/cardRuntimeContract.js';
import {
  getCardHostname,
  setCardHostname,
  pushConfigToCard,
  CardPushError,
} from '../../../lib/cardPushClient.js';

// Extracted verbatim from PatchBoardScreen.pushToCard + its push* state.
// `connected` is accepted for the Phase 3 props contract (ambient status
// dot) but is not used yet — no button invokes pushToCard in this step,
// preserving today's latent/unrendered behavior. Phase 3 wires a button
// in Wire mode.
export function CardPushControl({
  connected,
  board,
  strips,
  projectId,
  projectName,
  standaloneController,
}) {
  const [pushHost, setPushHost] = useState(() => getCardHostname());
  const [pushStatus, setPushStatus] = useState('');
  const [pushKind, setPushKind] = useState(''); // '' | 'ok' | 'err' | 'pending'
  const [pushFallbackJson, setPushFallbackJson] = useState('');

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
    const zones = patchBoardToZones(board, strips);
    const outputs = (standaloneController?.outputs || []).map((o, i) => ({
      id: o.id || `out${i + 1}`,
      name: o.name || `Output ${i + 1}`,
      pin: o.pin,
      pixels: o.pixels,
    }));
    const totalPixels = strips.reduce((sum, s) => sum + (s.pixelCount ?? s.pixels?.length ?? 0), 0);
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
      } else if (err instanceof CardPushError) {
        setPushStatus(err.message);
      } else {
        setPushStatus(`Push failed: ${err.message || err}`);
      }
    }
  };

  if (!pushStatus) return null;

  return (
    <div style={{
      padding: '10px 14px',
      margin: '4px 0 12px',
      borderRadius: 8,
      fontSize: 13,
      background: pushKind === 'ok' ? 'rgba(127,176,105,0.1)' : pushKind === 'err' ? 'rgba(224,120,86,0.1)' : 'rgba(154,141,117,0.1)',
      border: `1px solid ${pushKind === 'ok' ? 'rgba(127,176,105,0.5)' : pushKind === 'err' ? 'rgba(224,120,86,0.5)' : 'rgba(154,141,117,0.3)'}`,
      color: pushKind === 'ok' ? '#7fb069' : pushKind === 'err' ? '#e07856' : '#9a8d75',
    }}>
      {pushStatus}
      {pushFallbackJson && (
        <textarea
          readOnly
          value={pushFallbackJson}
          onClick={e => e.target.select()}
          style={{
            width: '100%',
            minHeight: 140,
            marginTop: 10,
            fontFamily: 'ui-monospace, SF Mono, monospace',
            fontSize: 11,
            padding: 10,
            borderRadius: 6,
            border: '1px solid var(--border, #333)',
            background: 'var(--bg-1, #0a0a0a)',
            color: 'var(--text-2, #c89b5c)',
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}
