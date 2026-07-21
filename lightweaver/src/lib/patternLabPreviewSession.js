import { createCardFrameStream } from './cardFrameStream.js';
import {
  pushLivePreviewToCard,
  readCardZonesFromCard,
  resetLiveOutputOnCard,
} from './cardLiveControl.js';

const RESTORE_FIELDS = [
  'patternId',
  'brightness',
  'speed',
  'hueShift',
  'customHue',
  'customSaturation',
  'customBreathe',
  'customDrift',
  'driftHueMin',
  'driftHueMax',
  'blackout',
];

function restoreLookFromZone(zone) {
  const look = {};
  for (const field of RESTORE_FIELDS) {
    if (Object.hasOwn(zone, field)) look[field] = zone[field];
  }
  return { ...look, zone: String(zone.id), syncZones: false };
}

function snapshotLooks(snapshot) {
  if (Array.isArray(snapshot?.zones) && snapshot.zones.length) {
    const looks = snapshot.zones
      .filter(zone => zone && String(zone.id || '').trim())
      .map(restoreLookFromZone);
    if (snapshot.syncZones === true && looks.length) {
      const { zone: _zone, ...first } = looks[0];
      return [{ ...first, syncZones: true }];
    }
    return looks;
  }
  const currentId = String(snapshot?.currentId || snapshot?.patternId || '').trim();
  return currentId ? [{ patternId: currentId, syncZones: true }] : [];
}

export function createPatternLabPreviewSession({
  host = '',
  fps = 18,
  fallbackLook = {},
  readSnapshot = options => readCardZonesFromCard(options),
  createStream = options => createCardFrameStream(options),
  restoreLook = (look, options) => pushLivePreviewToCard(look, options),
  resetOutput = (look, options) => resetLiveOutputOnCard(look, options),
  onStateChange = null,
} = {}) {
  let state = 'idle';
  let stream = null;
  let snapshot = null;
  let snapshotAvailable = false;
  let lastError = null;
  let restored = null;
  let rollbackPromise = null;

  function setState(next) {
    state = next;
    try { onStateChange?.({ state, active: state === 'live', error: lastError, restored }); } catch {}
  }

  async function restore() {
    const looks = snapshotAvailable ? snapshotLooks(snapshot) : [];
    if (!looks.length) {
      await resetOutput(fallbackLook, { host });
      return;
    }
    for (const look of looks) {
      await restoreLook(look, { host, latestOnly: false });
    }
  }

  async function rollback(reason = 'stop', terminalState = 'restored') {
    if (rollbackPromise) return rollbackPromise;
    if (!stream && state === 'idle') return undefined;
    rollbackPromise = (async () => {
      setState('stopping');
      try {
        await stream?.stop?.();
      } finally {
        try {
          await restore();
          restored = true;
          setState(terminalState);
        } catch (error) {
          lastError = error;
          restored = false;
          setState('error');
          throw error;
        } finally {
          stream = null;
        }
      }
      return { reason, restored: state === 'restored' };
    })();
    return rollbackPromise;
  }

  async function yieldToNewOwner() {
    if (rollbackPromise) return rollbackPromise;
    rollbackPromise = (async () => {
      setState('stopping');
      await stream?.stop?.();
      stream = null;
      restored = null;
      setState('superseded');
      return { reason: 'stream-superseded', restored: false, ownershipTransferred: true };
    })();
    return rollbackPromise;
  }

  function onHealth(health) {
    if (state !== 'live' || health?.delivered !== false) return;
    lastError = health.lastError || Object.assign(new Error('Physical preview stream stopped.'), {
      reason: health.reason || 'delivery-failed',
    });
    if (health.reason === 'stream-superseded' || health.reason === 'stream-reclaimed') {
      // The newer owner now controls the LEDs. Restoring through /api/control
      // would cancel that new stream, so only relinquish local resources.
      void yieldToNewOwner().catch(() => {});
      return;
    }
    void rollback(health.reason || 'delivery-failed').catch(() => {});
  }

  return {
    async start(initialFrame) {
      if (state !== 'idle') throw new Error('Pattern Lab physical preview session has already started');
      restored = null;
      setState('starting');
      try {
        try {
          snapshot = await readSnapshot({ host });
          snapshotAvailable = Boolean(snapshot);
        } catch {
          snapshot = null;
          snapshotAvailable = false;
        }
        stream = createStream({ host, fps, onHealth });
        const started = stream.start();
        if (started === false) throw new Error('Pattern Lab physical preview stream could not start');
        setState('live');
        if (initialFrame) stream.push(initialFrame);
        return true;
      } catch (error) {
        lastError = error;
        try {
          await rollback('start-error', 'error');
        } catch {
          setState('error');
        }
        setState('error');
        throw error;
      }
    },
    push(frame) {
      return state === 'live' ? Boolean(stream?.push(frame)) : false;
    },
    stop(reason = 'user') {
      return rollback(reason);
    },
    whenSettled() {
      return rollbackPromise || Promise.resolve();
    },
    status() {
      return {
        state,
        active: state === 'live',
        snapshotAvailable,
        error: lastError,
        restored,
      };
    },
  };
}
