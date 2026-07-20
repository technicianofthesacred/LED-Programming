import { useCallback, useEffect, useState } from 'react';
import {
  CARD_HOST_CHANGED_EVENT,
  CARD_CONNECTION_MISS_LIMIT,
  discoverCardStatus,
  readStoredCardHost,
  reduceCardConnectionState,
} from '../lib/cardConnection.js';
import { readPersistedCardIdentity } from '../lib/cardIdentity.js';

export function useCardStatus({
  enabled = true,
  intervalMs = 5000,
  reconnectIntervalMs = 2500,
  timeoutMs = 12000,
  missLimit = CARD_CONNECTION_MISS_LIMIT,
} = {}) {
  const [state, setState] = useState({
    checking: Boolean(enabled),
    connected: false,
    reconnecting: Boolean(enabled),
    host: readStoredCardHost(),
    status: null,
    detectedStatus: null,
    reason: '',
    allowAdopt: false,
    error: null,
    checkedAt: 0,
    missCount: 0,
    lastConnectedAt: 0,
  });

  const refresh = useCallback(async () => {
    if (!enabled) return { connected: false, host: readStoredCardHost(), error: new Error('direct card access disabled') };
    setState(prev => ({ ...prev, checking: true, error: null }));
    const result = await discoverCardStatus({
      preferredHost: readStoredCardHost(),
      expectedCard: readPersistedCardIdentity(),
      timeoutMs,
      persist: false,
    });
    setState(prev => reduceCardConnectionState(prev, { ...result, allowAdopt: false }, { now: Date.now(), missLimit }));
    return result;
  }, [enabled, missLimit, timeoutMs]);

  const connect = useCallback(async () => {
    if (!enabled) return { connected: false, host: readStoredCardHost(), error: new Error('direct card access disabled') };
    setState(prev => ({ ...prev, checking: true, reconnecting: true, error: null }));
    const result = await discoverCardStatus({
      preferredHost: readStoredCardHost(),
      expectedCard: readPersistedCardIdentity(),
      timeoutMs: Math.max(timeoutMs, 12000),
      persist: true,
    });
    setState(prev => reduceCardConnectionState(prev, { ...result, allowAdopt: false }, { now: Date.now(), missLimit }));
    return result;
  }, [enabled, missLimit, timeoutMs]);

  useEffect(() => {
    if (!enabled) {
      setState(prev => ({
        ...prev,
        checking: false,
        connected: false,
        reconnecting: false,
        error: null,
      }));
      return undefined;
    }
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
          expectedCard: readPersistedCardIdentity(),
          timeoutMs,
          persist: false,
        });
        if (!active) return;
        setState(prev => {
          const next = reduceCardConnectionState(prev, { ...result, allowAdopt: false }, { now: Date.now(), missLimit });
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
  }, [enabled, intervalMs, missLimit, reconnectIntervalMs, timeoutMs]);

  return { ...state, refresh, connect };
}
