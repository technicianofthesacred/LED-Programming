import { useCallback, useEffect, useState } from 'react';
import {
  CARD_HOST_CHANGED_EVENT,
  CARD_CONNECTION_MISS_LIMIT,
  discoverCardStatus,
  readStoredCardHost,
  reduceCardConnectionState,
} from '../lib/cardConnection.js';

export function useCardStatus({
  intervalMs = 5000,
  reconnectIntervalMs = 1600,
  timeoutMs = 900,
  missLimit = CARD_CONNECTION_MISS_LIMIT,
} = {}) {
  const [state, setState] = useState({
    checking: true,
    connected: false,
    reconnecting: true,
    host: readStoredCardHost(),
    status: null,
    error: null,
    checkedAt: 0,
    missCount: 0,
    lastConnectedAt: 0,
  });

  const refresh = useCallback(async () => {
    setState(prev => ({ ...prev, checking: true, error: null }));
    const result = await discoverCardStatus({
      preferredHost: readStoredCardHost(),
      timeoutMs,
      persist: false,
    });
    setState(prev => reduceCardConnectionState(prev, result, { now: Date.now(), missLimit }));
    return result;
  }, [missLimit, timeoutMs]);

  const connect = useCallback(async () => {
    setState(prev => ({ ...prev, checking: true, reconnecting: true, error: null }));
    const result = await discoverCardStatus({
      preferredHost: readStoredCardHost(),
      timeoutMs: Math.max(timeoutMs, 2200),
      persist: true,
    });
    setState(prev => reduceCardConnectionState(prev, result, { now: Date.now(), missLimit }));
    return result;
  }, [missLimit, timeoutMs]);

  useEffect(() => {
    let active = true;
    let timer = null;
    let latestState = state;
    let running = false;

    const guardedRefresh = async () => {
      if (!active || running) return;
      running = true;
      try {
        const result = await discoverCardStatus({
          preferredHost: readStoredCardHost(),
          timeoutMs,
          persist: false,
        });
        if (!active) return;
        setState(prev => {
          const next = reduceCardConnectionState(prev, result, { now: Date.now(), missLimit });
          latestState = next;
          return next;
        });
      } finally {
        running = false;
      }
    };
    const schedule = (delayMs) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        await guardedRefresh();
        if (!active) return;
        const nextDelay = latestState.connected && !latestState.reconnecting
          ? intervalMs
          : reconnectIntervalMs;
        schedule(document.visibilityState === 'hidden' ? Math.max(nextDelay, 15000) : nextDelay);
      }, delayMs);
    };
    const reconnectNow = () => {
      setState(prev => ({ ...prev, checking: true, reconnecting: true, error: null }));
      guardedRefresh();
    };

    reconnectNow();
    schedule(reconnectIntervalMs);
    const onHostChange = () => reconnectNow();
    const onOnline = () => reconnectNow();
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow();
    };
    window.addEventListener?.(CARD_HOST_CHANGED_EVENT, onHostChange);
    window.addEventListener?.('online', onOnline);
    document.addEventListener?.('visibilitychange', onVisible);
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener?.(CARD_HOST_CHANGED_EVENT, onHostChange);
      window.removeEventListener?.('online', onOnline);
      document.removeEventListener?.('visibilitychange', onVisible);
    };
  }, [intervalMs, missLimit, reconnectIntervalMs, timeoutMs]);

  return { ...state, refresh, connect };
}
