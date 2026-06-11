import { useState, useEffect, useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';
import { COLOR_ORDERS } from '../lib/usbLedColorOrder.js';
import { DEFAULT_LWUSB_MAX_PIXELS } from '../lib/usbLedFrame.js';

/**
 * WledBar — compact WLED connection bar.
 * Reads the shared WLED connection from ProjectContext (one WebSocket for the whole app).
 */
const WLED_LED_WARN = 500;
const CONNECTING_TIMEOUT_MS = 6500;

export function WledBar() {
  const {
    wledIp: ip,
    setWledIp: setIp,
    wledConnected: connected,
    wledTransport,
    wledError,
    wledConnect: connect,
    wledDisconnect: disconnect,
    strips,
    usbLedConnected,
    usbLedConnecting,
    usbLedStatus,
    usbLedLastError,
    usbLedColorOrder,
    usbLedConnect,
    usbLedDisconnect,
    usbLedCommand,
    usbLedApplyColorOrder,
    usbLedCalibrateColorOrder,
    usbLedCycleColorOrder,
  } = useProject();
  const totalLEDs = useMemo(() => strips.reduce((sum, strip) => (
    sum + (strip.pixels?.length || strip.pixelCount || 0)
  ), 0), [strips]);
  const usbPixelCount = Math.max(1, Math.min(usbLedStatus?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS, totalLEDs || 30));

  // Track whether a connection attempt is in flight (between connect() call and
  // the WebSocket open/error event).
  const [connecting, setConnecting] = useState(false);

  // Clear "connecting" spinner once state resolves (connected or a worded error)
  useEffect(() => {
    if (connected || wledError) setConnecting(false);
  }, [connected, wledError]);

  useEffect(() => {
    if (!connecting || connected) return undefined;
    const timer = setTimeout(() => setConnecting(false), CONNECTING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [connecting, connected]);

  function handleConnect() {
    if (connected) {
      disconnect();
      setConnecting(false);
    } else {
      setConnecting(true);
      connect();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      setConnecting(true);
      connect(ip);
    }
  }

  // Determine dot state
  const dotColor = connected
    ? 'oklch(72% 0.18 155)'    // green (mint-like)
    : connecting
      ? 'oklch(80% 0.18 70)'  // amber
      : 'oklch(64% 0.20 25)'; // red (danger)

  const dotLabel = connected ? 'connected' : connecting ? 'connecting' : 'disconnected';
  const usbDotColor = usbLedConnected
    ? 'oklch(72% 0.18 155)'
    : usbLedConnecting
      ? 'oklch(80% 0.18 70)'
      : 'oklch(64% 0.20 25)';

  async function handleUsbConnect() {
    try {
      if (usbLedConnected) {
        await usbLedDisconnect?.();
      } else {
        await usbLedConnect?.({ pixelCount: usbPixelCount, brightness: 64 });
      }
    } catch {
      // The hook keeps the latest error for the status tooltip.
    }
  }

  async function handleUsbColorOrderChange(order) {
    try {
      await usbLedCalibrateColorOrder?.(order, { pixelCount: usbPixelCount });
    } catch {
      await usbLedApplyColorOrder?.(order).catch(() => {});
    }
  }

  async function handleUsbColorOrderCycle() {
    try {
      await usbLedCycleColorOrder?.({ pixelCount: usbPixelCount });
    } catch {
      // The hook keeps the latest error for the status tooltip.
    }
  }

  return (
    <div style={styles.bar}>
      <span
        title={usbLedConnected ? 'USB direct connected' : usbLedConnecting ? 'USB direct connecting' : usbLedLastError || 'USB direct disconnected'}
        style={{
          ...styles.dot,
          background: usbDotColor,
          boxShadow: `0 0 6px ${usbDotColor}`,
        }}
      />
      <span style={styles.label}>USB</span>
      <button
        aria-label={usbLedConnected ? 'Disconnect USB LED controller' : 'Connect USB LED controller'}
        onClick={handleUsbConnect}
        disabled={usbLedConnecting}
        style={{
          ...styles.btn,
          ...(usbLedConnected ? styles.btnDisconnect : styles.btnConnect),
          opacity: usbLedConnecting ? 0.6 : 1,
        }}
      >
        {usbLedConnected ? 'Disconnect' : usbLedConnecting ? 'Connecting...' : 'Connect'}
      </button>
      <button
        aria-label="Send warm USB LED test"
        onClick={() => usbLedCommand?.('WARM').catch(() => {})}
        disabled={!usbLedConnected}
        style={{ ...styles.btn, ...styles.btnGhost, opacity: usbLedConnected ? 1 : 0.45 }}
      >
        Warm
      </button>
      <button
        aria-label="Send USB RGB calibration test"
        onClick={() => usbLedCalibrateColorOrder?.(usbLedStatus?.colorOrder || usbLedColorOrder, { pixelCount: usbPixelCount }).catch(() => {})}
        disabled={!usbLedConnected}
        style={{ ...styles.btn, ...styles.btnGhost, opacity: usbLedConnected ? 1 : 0.45 }}
        title="Show red, green, blue sections for color-order calibration"
      >
        RGB Test
      </button>
      <button
        aria-label="Cycle USB LED color order"
        onClick={handleUsbColorOrderCycle}
        disabled={!usbLedConnected}
        style={{ ...styles.btn, ...styles.btnGhost, opacity: usbLedConnected ? 1 : 0.45 }}
        title="Try the next color order and show the RGB calibration frame"
      >
        Cycle
      </button>
      <select
        aria-label="USB LED color order"
        value={usbLedColorOrder || usbLedStatus?.colorOrder || 'RGB'}
        disabled={!usbLedConnected}
        onChange={event => handleUsbColorOrderChange(event.target.value)}
        style={{ ...styles.select, opacity: usbLedConnected ? 1 : 0.45 }}
        title="Change color order if red appears green or blue"
      >
        {COLOR_ORDERS.map(order => <option key={order} value={order}>{order}</option>)}
      </select>
      <button
        aria-label="Send red USB LED test"
        onClick={() => usbLedCommand?.('SOLID 255 0 0').catch(() => {})}
        disabled={!usbLedConnected}
        style={{ ...styles.swatchBtn, background: '#e83a4a', opacity: usbLedConnected ? 1 : 0.45 }}
        title="Red test"
      />
      <button
        aria-label="Send green USB LED test"
        onClick={() => usbLedCommand?.('SOLID 0 255 0').catch(() => {})}
        disabled={!usbLedConnected}
        style={{ ...styles.swatchBtn, background: '#35c76f', opacity: usbLedConnected ? 1 : 0.45 }}
        title="Green test"
      />
      <button
        aria-label="Send blue USB LED test"
        onClick={() => usbLedCommand?.('SOLID 0 0 255').catch(() => {})}
        disabled={!usbLedConnected}
        style={{ ...styles.swatchBtn, background: '#3b82f6', opacity: usbLedConnected ? 1 : 0.45 }}
        title="Blue test"
      />
      {usbLedConnected && (
        <span style={styles.hint}>direct · {usbLedStatus?.colorOrder || usbLedColorOrder || 'RGB'} · {usbLedStatus?.lastFramePixels || usbPixelCount} px</span>
      )}

      <span style={styles.sep}/>

      {/* Status dot */}
      <span
        title={wledError || dotLabel}
        style={{
          ...styles.dot,
          background: dotColor,
          boxShadow: `0 0 6px ${dotColor}`,
        }}
      />

      {/* Card label */}
      <span style={styles.label}>Card</span>

      {/* Hostname or IP input */}
      <input
        aria-label="Card hostname or IP"
        type="text"
        value={ip}
        onChange={e => setIp(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="lightweaver.local or 192.168.x.x"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={connected}
        style={{
          ...styles.input,
          opacity: connected ? 0.5 : 1,
          cursor: connected ? 'default' : 'text',
        }}
      />

      {/* Connect / Disconnect button */}
      <button
        aria-label={connected ? 'Disconnect from card' : 'Connect to card'}
        onClick={handleConnect}
        disabled={connecting && !connected}
        style={{
          ...styles.btn,
          ...(connected ? styles.btnDisconnect : styles.btnConnect),
          opacity: (connecting && !connected) ? 0.6 : 1,
        }}
      >
        {connected ? 'Disconnect' : connecting ? 'Connecting…' : 'Connect'}
      </button>

      {/* Push rate hint when connected */}
      {connected && (
        <span style={styles.hint}>{wledTransport === 'proxy' ? 'via Pi' : 'direct'} · 25 fps max</span>
      )}
      {/* Worded error (e.g. https mixed-content cannot reach a local card) */}
      {!connected && wledError && (
        <span
          role="alert"
          title={wledError}
          style={{ ...styles.hint, color: 'oklch(64% 0.20 25)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 320 }}
        >
          {wledError}
        </span>
      )}
      {/* LED count warning */}
      {totalLEDs > WLED_LED_WARN && (
        <span style={{ ...styles.hint, color: 'oklch(80% 0.18 70)' }}
              title={`${totalLEDs} LEDs — above ~500 LEDs the card's realtime stream may stutter. Consider splitting into zones.`}>
          ⚠ {totalLEDs} LEDs
        </span>
      )}
    </div>
  );
}

const styles = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 10px',
    height: '34px',
    flexShrink: 0,
    borderTop: '1px solid var(--border)',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
    transition: 'background 0.2s, box-shadow 0.2s',
  },
  label: {
    fontFamily: 'var(--mono-font)',
    fontSize: '10px',
    color: 'var(--text-3)',
    letterSpacing: '0.06em',
    userSelect: 'none',
    marginRight: '2px',
  },
  input: {
    fontFamily: 'var(--mono-font)',
    fontSize: '10px',
    color: 'var(--text)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    padding: '2px 7px',
    width: '120px',
    minHeight: '24px',
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  btn: {
    fontFamily: 'var(--mono-font)',
    fontSize: '10px',
    fontWeight: '500',
    letterSpacing: '0.04em',
    padding: '2px 9px',
    minHeight: '24px',
    borderRadius: '3px',
    border: '1px solid transparent',
    cursor: 'pointer',
    transition: 'all 0.12s',
    flexShrink: 0,
  },
  btnConnect: {
    background: 'oklch(74% 0.13 210 / 0.15)',
    borderColor: 'oklch(74% 0.13 210 / 0.4)',
    color: 'var(--accent)',
  },
  btnDisconnect: {
    background: 'oklch(64% 0.20 25 / 0.12)',
    borderColor: 'oklch(64% 0.20 25 / 0.35)',
    color: 'var(--danger)',
  },
  hint: {
    fontFamily: 'var(--mono-font)',
    fontSize: '10px',
    color: 'var(--text-4)',
    letterSpacing: '0.02em',
  },
  sep: {
    width: '1px',
    height: '18px',
    background: 'var(--border)',
    margin: '0 4px',
    flexShrink: 0,
  },
  btnGhost: {
    background: 'transparent',
    borderColor: 'var(--border)',
    color: 'var(--text-3)',
  },
  select: {
    fontFamily: 'var(--mono-font)',
    fontSize: '10px',
    color: 'var(--text)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    padding: '2px 5px',
    minHeight: '24px',
    outline: 'none',
    flexShrink: 0,
  },
  swatchBtn: {
    width: '22px',
    height: '22px',
    borderRadius: '3px',
    border: '1px solid var(--border)',
    cursor: 'pointer',
    flexShrink: 0,
  },
};
