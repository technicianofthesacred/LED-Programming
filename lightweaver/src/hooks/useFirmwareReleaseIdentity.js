import { useEffect, useMemo, useState } from 'react';
import { loadProductionFirmwareManifest } from '../lib/firmwareRelease.js';

const initialState = () => Object.freeze({ state: 'loading', manifest: null, error: '' });

function verifiedState(manifest) {
  return Object.freeze({ state: 'verified', manifest, error: '' });
}

function unknownState() {
  return Object.freeze({
    state: 'release-unknown',
    manifest: null,
    error: 'release-verification-failed',
  });
}

export function createFirmwareReleaseIdentityLifecycle({ loadManifest, onChange = () => {} }) {
  let state = initialState();
  let generation = 0;
  let identityKey = null;

  const publish = next => {
    state = next;
    onChange(state);
    return state;
  };

  const load = async (nextIdentityKey, force) => {
    if (!force && nextIdentityKey === identityKey) return state;
    identityKey = nextIdentityKey;
    const requestGeneration = ++generation;
    publish(initialState());
    try {
      const manifest = await loadManifest();
      if (requestGeneration === generation) publish(verifiedState(manifest));
    } catch {
      if (requestGeneration === generation) publish(unknownState());
    }
    return state;
  };

  return Object.freeze({
    getState: () => state,
    reload: nextIdentityKey => load(String(nextIdentityKey || ''), false),
    retry: () => load(identityKey, true),
    stop: () => { generation += 1; },
  });
}

function loadBrowserFirmwareManifest() {
  return loadProductionFirmwareManifest(window.fetch.bind(window), window.crypto);
}

export function useFirmwareReleaseIdentity(studioIdentityKey, {
  loadManifest = loadBrowserFirmwareManifest,
} = {}) {
  const [state, setState] = useState(initialState);
  const lifecycle = useMemo(() => createFirmwareReleaseIdentityLifecycle({
    loadManifest,
    onChange: setState,
  }), [loadManifest]);

  useEffect(() => {
    void lifecycle.reload(studioIdentityKey);
  }, [lifecycle, studioIdentityKey]);

  useEffect(() => {
    const retryOnline = () => { void lifecycle.retry(); };
    window.addEventListener('online', retryOnline);
    return () => window.removeEventListener('online', retryOnline);
  }, [lifecycle]);

  useEffect(() => () => lifecycle.stop(), [lifecycle]);
  return state;
}
