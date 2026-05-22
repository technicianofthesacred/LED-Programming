import { useState, useEffect, useRef, useCallback } from 'react';
import { DEFAULT_WLED_PUSH_FPS, makeWledFrameMessage, makeWledWsUrl, requestWledJson } from '../lib/deviceController.js';

const STORAGE_KEY = 'lw_wled_ip';
const PUSH_FPS_KEY = 'lw_wled_push_fps';
const RECONNECT_DELAY   = 3000;

export function useWled() {
  const [ip, setIpState]     = useState(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [connected, setConnected] = useState(false);
  const [transport, setTransport] = useState('offline');

  const wsRef          = useRef(null);
  const reconnTimerRef = useRef(null);
  const lastPushRef    = useRef(0);
  const intentionalCloseRef = useRef(false);

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
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    setConnected(false);
    setTransport('offline');
  }, []);

  const connect = useCallback((targetIp, mode = 'proxy') => {
    // Allow passing an explicit IP (e.g. from input field before state update)
    const addr = (targetIp ?? ip).trim();
    if (!addr) return;

    clearReconnect();
    intentionalCloseRef.current = false;

    // Close any existing socket first
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }

    let ws;
    let opened = false;
    try {
      ws = new WebSocket(makeWledWsUrl(addr, { preferProxy: mode === 'proxy' }));
    } catch {
      if (mode === 'proxy') connect(addr, 'direct');
      return;
    }

    ws.onopen = () => {
      opened = true;
      wsRef.current = ws;
      setConnected(true);
      setTransport(mode);
    };

    ws.onerror = () => {
      // Errors are followed by onclose, handle reconnect there
    };

    ws.onclose = () => {
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
        // Auto-reconnect if an IP is set
        const storedIp = localStorage.getItem(STORAGE_KEY) ?? '';
        if (storedIp) {
          reconnTimerRef.current = setTimeout(() => connect(storedIp), RECONNECT_DELAY);
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
    ip, setIp, connected, transport, connect, disconnect, push,
    setPreset, setPower, setBrightness, getState, getInfo,
  };
}
