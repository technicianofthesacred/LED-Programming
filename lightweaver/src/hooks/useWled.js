import { useState, useEffect, useRef, useCallback } from 'react';
import { DEFAULT_WLED_PUSH_FPS, makeWledFrameMessage } from '../lib/deviceController.js';

const STORAGE_KEY = 'lw_wled_ip';
const MIN_PUSH_INTERVAL = 1000 / DEFAULT_WLED_PUSH_FPS;
const PUSH_FPS_KEY = 'lw_wled_push_fps';
const RECONNECT_DELAY   = 3000;
const HTTP_TIMEOUT_MS   = 3000;

export function useWled() {
  const [ip, setIpState]     = useState(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [connected, setConnected] = useState(false);

  const wsRef          = useRef(null);
  const reconnTimerRef = useRef(null);
  const lastPushRef    = useRef(0);

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
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    setConnected(false);
  }, []);

  const connect = useCallback((targetIp) => {
    // Allow passing an explicit IP (e.g. from input field before state update)
    const addr = (targetIp ?? ip).trim();
    if (!addr) return;

    clearReconnect();

    // Close any existing socket first
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }

    const ws = new WebSocket(`ws://${addr}/ws`);

    ws.onopen = () => {
      wsRef.current = ws;
      setConnected(true);
    };

    ws.onerror = () => {
      // Errors are followed by onclose, handle reconnect there
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
        setConnected(false);
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

  /** Internal: fetch with AbortController-based timeout. */
  const _fetchWithTimeout = useCallback((url, opts = {}) => {
    const addr = (opts._ip ?? ip).trim();
    if (!addr) return Promise.reject(new Error('No WLED IP configured'));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    const { _ip, ...fetchOpts } = opts;
    return fetch(url, { ...fetchOpts, signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`WLED HTTP ${res.status}`);
        return res.json();
      })
      .finally(() => clearTimeout(timer));
  }, [ip]);

  /** POST a partial state object to /json/state. */
  const _postState = useCallback((body) => {
    const addr = ip.trim();
    if (!addr) return Promise.reject(new Error('No WLED IP configured'));
    return _fetchWithTimeout(`http://${addr}/json/state`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  }, [ip, _fetchWithTimeout]);

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
    return _fetchWithTimeout(`http://${addr}/json/state`);
  }, [ip, _fetchWithTimeout]);

  /** GET parsed /json/info. */
  const getInfo = useCallback(() => {
    const addr = ip.trim();
    if (!addr) return Promise.reject(new Error('No WLED IP configured'));
    return _fetchWithTimeout(`http://${addr}/json/info`);
  }, [ip, _fetchWithTimeout]);

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
    ip, setIp, connected, connect, disconnect, push,
    setPreset, setPower, setBrightness, getState, getInfo,
  };
}
