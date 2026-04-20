import { useState, useEffect, useRef, useCallback } from 'react';

const STORAGE_KEY = 'lw_wled_ip';
const MIN_PUSH_INTERVAL = 40; // 25fps max
const RECONNECT_DELAY   = 3000;

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
    if (now - lastPushRef.current < MIN_PUSH_INTERVAL) return;
    lastPushRef.current = now;

    // Build flat [r0,g0,b0, r1,g1,b1, ...] array
    const flat = new Array(pixels.length * 3);
    for (let i = 0; i < pixels.length; i++) {
      flat[i * 3]     = pixels[i].r;
      flat[i * 3 + 1] = pixels[i].g;
      flat[i * 3 + 2] = pixels[i].b;
    }

    try {
      ws.send(JSON.stringify({ v: true, seg: [{ i: flat }] }));
    } catch { /* socket may be closing */ }
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearReconnect();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
      }
    };
  }, []);

  return { ip, setIp, connected, connect, disconnect, push };
}
