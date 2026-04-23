import { useState, useEffect, useMemo } from 'react';
import { useProject } from '../state/ProjectContext.jsx';

/**
 * WledBar — compact WLED connection bar.
 * Reads the shared WLED connection from ProjectContext (one WebSocket for the whole app).
 */
const WLED_LED_WARN = 500;

export function WledBar() {
  const { wledIp: ip, setWledIp: setIp, wledConnected: connected, wledConnect: connect, wledDisconnect: disconnect, strips } = useProject();
  const totalLEDs = useMemo(() => strips.reduce((s, st) => s + (st.pixels?.length || 0), 0), [strips]);

  // Track whether a connection attempt is in flight (between connect() call and
  // the WebSocket open/error event).
  const [connecting, setConnecting] = useState(false);

  // Clear "connecting" spinner once state resolves
  useEffect(() => {
    if (connected) setConnecting(false);
  }, [connected]);

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

  return (
    <div style={styles.bar}>
      {/* Status dot */}
      <span
        title={dotLabel}
        style={{
          ...styles.dot,
          background: dotColor,
          boxShadow: `0 0 6px ${dotColor}`,
        }}
      />

      {/* WLED label */}
      <span style={styles.label}>WLED</span>

      {/* IP input */}
      <input
        type="text"
        value={ip}
        onChange={e => setIp(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="192.168.x.x"
        spellCheck={false}
        disabled={connected}
        style={{
          ...styles.input,
          opacity: connected ? 0.5 : 1,
          cursor: connected ? 'default' : 'text',
        }}
      />

      {/* Connect / Disconnect button */}
      <button
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
        <span style={styles.hint}>25 fps max</span>
      )}
      {/* LED count warning */}
      {totalLEDs > WLED_LED_WARN && (
        <span style={{ ...styles.hint, color: 'oklch(80% 0.18 70)' }}
              title={`${totalLEDs} LEDs — WLED WebSocket may have trouble above ~500 LEDs per segment. Consider splitting into segments.`}>
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
    outline: 'none',
    transition: 'border-color 0.15s',
  },
  btn: {
    fontFamily: 'var(--mono-font)',
    fontSize: '10px',
    fontWeight: '500',
    letterSpacing: '0.04em',
    padding: '2px 9px',
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
};
