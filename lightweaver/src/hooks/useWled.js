import { useState, useEffect, useRef, useCallback } from 'react';
import { DEFAULT_WLED_PUSH_FPS, makeWledFrameMessage, makeWledWsUrl, requestWledJson } from '../lib/deviceController.js';

const STORAGE_KEY = 'lw_wled_ip';
const PUSH_FPS_KEY = 'lw_wled_push_fps';
const RECONNECT_DELAY    = 3000;  // base for exponential backoff
const RECONNECT_CAP_MS   = 15000; // maximum backoff ceiling
const CONNECT_TIMEOUT_MS = 5000;

const HTTPS_BLOCKED_MESSAGE =
  "Can't reach the card directly from the secure site — open your card's page to link Studio, or use the local dev server.";

// True when the page is served over https and the WLED target can't be reached
// over ws:// from it. Browsers block ws:// (mixed content) from an https origin
// for every host except secure-context locals (localhost / loopback), and the
// failure is silent — the WebSocket constructor throws or the socket errors
// with no detail. Surface a worded explanation instead of a wordless red dot.
function httpsMixedContentBlocked(addr, locationObj = globalThis.location) {
  if (locationObj?.protocol !== 'https:') return false;
  const host = String(addr || '').trim().toLowerCase().replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
  if (!host) return false;
  // localhost / loopback are treated as secure contexts, so ws:// to them works.
  const isSecureLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return !isSecureLocal;
}

export function useWled() {
  const [ip, setIpState]     = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  });
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState('offline');
  const [error, setError]         = useState('');

  const wsRef               = useRef(null);
  const reconnTimerRef      = useRef(null);
  const lastPushRef         = useRef(0);
  const intentionalCloseRef = useRef(false);
  const reconnAttemptRef    = useRef(0);

  // Persist IP to localStorage whenever it changes
  const setIp = useCallback((value) => {
    setIpState(value);
    localStorage.setItem(STORAGE_KEY, value);
  }, []);

  const clearReconnect = () => {
    if (reconnTimerRef.current !== null) {
      clearTimeout(reconnTimerRef.current);
      reconnTimerRef.current = null;
    }
  };

  const disconnect = useCallback(() => {
    clearReconnect();
    intentionalCloseRef.current = true;
    reconnAttemptRef.current = 0;
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    setConnected(false);
    setTransport('offline');
    setError('');
  }, []);

  const connect = useCallback((targetIp, mode = defaultWledMode()) => {
    // Allow passing an explicit IP (e.g. from input field before state update)
    const addr = (targetIp ?? ip).trim();
    if (!addr) return;

    clearReconnect();
    intentionalCloseRef.current = false;

    // On an https page, ws:// to a (non-secure) local card is blocked by the
    // browser as mixed content and fails silently. Surface guidance instead of
    // spinning forever and showing a wordless red dot.
    if (httpsMixedContentBlocked(addr)) {
      setError(HTTPS_BLOCKED_MESSAGE);
      setConnected(false);
      setTransport('offline');
      return;
    }
    setError('');

    // Close any existing socket first
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }

    let ws;
    let opened = false;
    let connectTimer = null;
    try {
      ws = new WebSocket(makeWledWsUrl(addr, { preferProxy: mode === 'proxy' }));
    } catch {
      if (mode === 'proxy') connect(addr, 'direct');
      return;
    }

    connectTimer = setTimeout(() => {
      if (!opened) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      opened = true;
      wsRef.current = ws;
      reconnAttemptRef.current = 0;
      setConnected(true);
      setTransport(mode);
      setError('');
    };

    ws.onerror = () => {
      // Errors are followed by onclose, handle reconnect there
    };

    ws.onclose = () => {
      clearTimeout(connectTimer);
      if (intentionalCloseRef.current) return;

      if (wsRef.current === ws) {
        wsRef.current = null;
        setConnected(false);
        setTransport('offline');
      }

      if (!opened && mode === 'proxy') {
        connect(addr, 'direct');
        return;
      }

      if (wsRef.current === null) {
        // Auto-reconnect if an IP is set, using jittered exponential backoff
        // to avoid thundering-herd when multiple tabs reconnect simultaneously.
        // delay = random in [0, min(cap, base * 2^attempt)]
        const storedIp = localStorage.getItem(STORAGE_KEY) ?? '';
        if (storedIp) {
          const attempt = reconnAttemptRef.current;
          reconnAttemptRef.current = attempt + 1;
          const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_DELAY * Math.pow(2, attempt));
          const delay = Math.random() * ceiling;
          reconnTimerRef.current = setTimeout(() => connect(storedIp), delay);
        }
      }
    };
  }, [ip]);

  /**
   * Push a pixel array to WLED over the open WebSocket.
   * @param {Array<{r:number,g:number,b:number}>} pixels
   */
  const push = useCallback((pixels) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    const configuredFps = Number(localStorage.getItem(PUSH_FPS_KEY)) || DEFAULT_WLED_PUSH_FPS;
    const minInterval = 1000 / Math.max(1, Math.min(60, configuredFps));
    if (now - lastPushRef.current < minInterval) return;
    lastPushRef.current = now;

    try {
      ws.send(JSON.stringify(makeWledFrameMessage(pixels)));
    } catch { /* socket may be closing */ }
  }, []);

  // ── HTTP JSON API (visitor UI controls) ────────────────────────────────
  // WLED docs: https://kno.wled.ge/interfaces/json-api/

  /** POST a partial state object to /json/state. */
  const _postState = useCallback((body) => {
    const addr = ip.trim();
    if (!addr) return Promise.reject(new Error('No WLED IP configured'));
    return requestWledJson(addr, 'state', { method: 'POST', body });
  }, [ip]);

  /** Apply a stored WLED preset by id. */
  const setPreset = useCallback((presetId) => {
    return _postState({ ps: Number(presetId) });
  }, [_postState]);

  /** Turn output on/off. */
  const setPower = useCallback((on) => {
    return _postState({ on: !!on });
  }, [_postState]);

  /** Set master brightness, clamped to 0..255. */
  const setBrightness = useCallback((bri) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(bri) || 0)));
    return _postState({ bri: v });
  }, [_postState]);

  /** GET parsed /json/state. */
  const getState = useCallback(() => {
    const addr = ip.trim();
    if (!addr) return Promise.reject(new Error('No WLED IP configured'));
    return requestWledJson(addr, 'state');
  }, [ip]);

  /** GET parsed /json/info. */
  const getInfo = useCallback(() => {
    const addr = ip.trim();
    if (!addr) return Promise.reject(new Error('No WLED IP configured'));
    return requestWledJson(addr, 'info');
  }, [ip]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearReconnect();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  return {
    ip, setIp, connected, transport, error, connect, disconnect, push,
    setPreset, setPower, setBrightness, getState, getInfo,
  };
}

function defaultWledMode(locationObj = globalThis.location) {
  // Pi proxy was the original plan when the designer ran on a Pi serving
  // both itself and the WLED endpoint. Today the designer talks directly
  // to the card's WebSocket on the LAN. The proxy route only exists on
  // a Pi deployment; default to direct everywhere.
  return 'direct';
}
