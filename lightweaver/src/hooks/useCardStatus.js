import { useCallback, useEffect, useState } from 'react';
import {
  CARD_HOST_CHANGED_EVENT,
  discoverCardStatus,
  readStoredCardHost,
} from '../lib/cardConnection.js';

export function useCardStatus({ intervalMs = 5000, timeoutMs = 900 } = {}) {
  const [state, setState] = useState({
    checking: true,
    connected: false,
    host: readStoredCardHost(),
    status: null,
    error: null,
    checkedAt: 0,
  });

  const refresh = useCallback(async () => {
    setState(prev => ({ ...prev, checking: true, error: null }));
    const result = await discoverCardStatus({
      preferredHost: readStoredCardHost(),
      timeoutMs,
      persist: false,
    });
    setState({
      checking: false,
      connected: result.connected,
      host: result.host,
      status: result.status || null,
      error: result.error || null,
      checkedAt: Date.now(),
    });
    return result;
  }, [timeoutMs]);

  const connect = useCallback(async () => {
    setState(prev => ({ ...prev, checking: true, error: null }));
    const result = await discoverCardStatus({
      preferredHost: readStoredCardHost(),
      timeoutMs: Math.max(timeoutMs, 1800),
      persist: true,
    });
    setState({
      checking: false,
      connected: result.connected,
      host: result.host,
      status: result.status || null,
      error: result.error || null,
      checkedAt: Date.now(),
    });
    return result;
  }, [timeoutMs]);

  useEffect(() => {
    let active = true;
    const guardedRefresh = async () => {
      const result = await discoverCardStatus({
        preferredHost: readStoredCardHost(),
        timeoutMs,
        persist: false,
      });
      if (!active) return;
      setState({
        checking: false,
        connected: result.connected,
        host: result.host,
        status: result.status || null,
        error: result.error || null,
        checkedAt: Date.now(),
      });
    };

    guardedRefresh();
    const timer = setInterval(guardedRefresh, intervalMs);
    const onHostChange = () => guardedRefresh();
    window.addEventListener?.(CARD_HOST_CHANGED_EVENT, onHostChange);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener?.(CARD_HOST_CHANGED_EVENT, onHostChange);
    };
  }, [intervalMs, timeoutMs]);

  return { ...state, refresh, connect };
}
