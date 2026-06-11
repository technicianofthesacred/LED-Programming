import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LWUSB_MAX_PIXELS,
  DEFAULT_LWUSB_PUSH_FPS,
  getLwUsbSerialSafeFps,
  normalizeLwUsbPixelCount,
  pixelsToLwUsbFrameHex,
} from '../lib/usbLedFrame.js';
import { getUsbLedStatusPollInterval } from '../lib/usbLedStatusPolling.js';
import {
  makeUsbLedCalibrationPixels,
  makeUsbLedColorOrderCommand,
  nextUsbLedColorOrder,
  normalizeUsbLedColorOrder,
} from '../lib/usbLedColorOrder.js';

const USB_PUSH_FPS_KEY = 'lw_usb_push_fps';
const USB_COLOR_ORDER_KEY = 'lw_usb_color_order';

// Marker error thrown when the /api/usb-led/* endpoint does not exist (the dev
// server route is absent in production). Callers use this to stop polling.
export const USB_LED_UNAVAILABLE = 'usb-led-endpoint-unavailable';

function readLocalStorage(key) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* storage blocked / quota */
  }
}

async function requestUsbLed(path, {
  method = 'GET',
  body,
  timeoutMs = 2500,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/usb-led/${path}`, {
      method,
      headers: body == null ? undefined : { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers?.get?.('content-type') || '';
    const isJson = contentType.includes('application/json');
    // The /api/usb-led/* routes only exist on the dev server. In production a
    // 404/405 (or a non-JSON SPA fallback page) means the endpoint isn't there;
    // signal that so the hook can stop polling for the rest of the session.
    if (response.status === 404 || response.status === 405 || !isJson) {
      const err = new Error(USB_LED_UNAVAILABLE);
      err.usbLedUnavailable = true;
      throw err;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `USB LED HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function useUsbLed() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState(null);
  const [lastError, setLastError] = useState('');
  const [colorOrder, setColorOrderState] = useState(() => normalizeUsbLedColorOrder(readLocalStorage(USB_COLOR_ORDER_KEY)));
  const lastPushRef = useRef(0);
  const pushInFlightRef = useRef(false);
  const holdUntilRef = useRef(0);
  // Once the dev-only /api/usb-led endpoint is found missing, stop polling it
  // for the rest of the session (it never reappears in production).
  const unavailableRef = useRef(false);

  const setColorOrder = useCallback((value) => {
    const next = normalizeUsbLedColorOrder(value);
    setColorOrderState(next);
    writeLocalStorage(USB_COLOR_ORDER_KEY, next);
    return next;
  }, []);

  const refreshStatus = useCallback(async () => {
    if (unavailableRef.current) return null;
    try {
      const next = await requestUsbLed('status', { timeoutMs: 1200 });
      setStatus(next);
      setConnected(!!next.connected);
      if (next.colorOrder) setColorOrder(next.colorOrder);
      setLastError(next.lastError || '');
      return next;
    } catch (error) {
      if (error?.usbLedUnavailable) unavailableRef.current = true;
      setConnected(false);
      if (!error?.usbLedUnavailable) setLastError(error.message);
      return null;
    }
  }, [setColorOrder]);

  const holdOutput = useCallback((durationMs = 3200) => {
    holdUntilRef.current = Math.max(holdUntilRef.current, Date.now() + durationMs);
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (unavailableRef.current) return undefined;
    const intervalMs = getUsbLedStatusPollInterval({ connected, connecting });
    if (!intervalMs) return undefined;
    const timer = setInterval(() => {
      if (unavailableRef.current) {
        clearInterval(timer);
        return;
      }
      refreshStatus();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [connected, connecting, refreshStatus]);

  const connect = useCallback(async ({ pixelCount, brightness = 64, portPath, colorOrder: requestedOrder } = {}) => {
    setConnecting(true);
    setLastError('');
    try {
      const body = {
        portPath,
        pixelCount: normalizeLwUsbPixelCount(pixelCount, { maxPixels: status?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS }),
        brightness,
      };
      if (requestedOrder != null) body.colorOrder = normalizeUsbLedColorOrder(requestedOrder);
      const next = await requestUsbLed('connect', {
        method: 'POST',
        body,
        timeoutMs: 5000,
      });
      setStatus(next);
      if (next.colorOrder) setColorOrder(next.colorOrder);
      setConnected(!!next.connected);
      return next;
    } catch (error) {
      setConnected(false);
      setLastError(error.message);
      throw error;
    } finally {
      setConnecting(false);
    }
  }, [setColorOrder, status?.maxPixels]);

  const disconnect = useCallback(async () => {
    setConnecting(false);
    try {
      const next = await requestUsbLed('disconnect', { method: 'POST', timeoutMs: 2000 });
      setStatus(next);
      setConnected(false);
    } catch (error) {
      setLastError(error.message);
    }
  }, []);

  const command = useCallback(async (commandText) => {
    if (/^(SOLID|CHASE|WARM|TEST|CLEAR)\b/i.test(String(commandText || '').trim())) {
      holdOutput(3200);
    }
    try {
      const next = await requestUsbLed('command', {
        method: 'POST',
        body: { command: commandText },
        timeoutMs: 4000,
      });
      const nextStatus = next.status || next;
      setStatus(nextStatus);
      if (nextStatus.colorOrder) setColorOrder(nextStatus.colorOrder);
      setConnected(!!nextStatus.connected);
      return next;
    } catch (error) {
      setLastError(error.message);
      throw error;
    }
  }, [holdOutput, setColorOrder]);

  const applyColorOrder = useCallback(async (value) => {
    const nextOrder = setColorOrder(value);
    const result = await command(makeUsbLedColorOrderCommand(nextOrder));
    return result;
  }, [command, setColorOrder]);

  const calibrateColorOrder = useCallback(async (value, { pixelCount, holdMs = 7000 } = {}) => {
    const nextOrder = setColorOrder(value);
    holdOutput(holdMs);
    await command(makeUsbLedColorOrderCommand(nextOrder));
    const next = await requestUsbLed('frame', {
      method: 'POST',
      body: { pixels: makeUsbLedCalibrationPixels(pixelCount || status?.lastFramePixels || 30) },
      timeoutMs: 1400,
    });
    const nextStatus = next.status || next;
    setStatus(nextStatus);
    if (nextStatus.colorOrder) setColorOrder(nextStatus.colorOrder);
    setConnected(!!nextStatus.connected);
    return next;
  }, [command, holdOutput, setColorOrder, status?.lastFramePixels]);

  const cycleColorOrder = useCallback(async ({ pixelCount, holdMs } = {}) => {
    return calibrateColorOrder(nextUsbLedColorOrder(status?.colorOrder || colorOrder), { pixelCount, holdMs });
  }, [calibrateColorOrder, colorOrder, status?.colorOrder]);

  const applyPixelCount = useCallback(async (value) => {
    return command(`COUNT ${normalizeLwUsbPixelCount(value, { maxPixels: status?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS })}`);
  }, [command, status?.maxPixels]);

  const push = useCallback((pixels) => {
    if (!connected || pushInFlightRef.current) return;
    if (Date.now() < holdUntilRef.current) return;
    const now = performance.now();
    const hex = pixelsToLwUsbFrameHex(pixels, { maxPixels: status?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS });
    if (!hex) return;

    const configuredFps = Number(readLocalStorage(USB_PUSH_FPS_KEY)) || DEFAULT_LWUSB_PUSH_FPS;
    const framePixels = hex.length / 6;
    const safeFps = getLwUsbSerialSafeFps(framePixels, {
      baudRate: status?.baudRate,
      maxFps: configuredFps,
    });
    const minInterval = 1000 / safeFps;
    if (now - lastPushRef.current < minInterval) return;

    lastPushRef.current = now;
    pushInFlightRef.current = true;
    requestUsbLed('frame', {
      method: 'POST',
      body: { hex },
      timeoutMs: 1200,
    })
      .then(next => {
        if (next.status) setStatus(next.status);
      })
      .catch(error => {
        setLastError(error.message);
      })
      .finally(() => {
        pushInFlightRef.current = false;
      });
  }, [connected, status?.maxPixels]);

  return {
    connected,
    connecting,
    status,
    lastError,
    colorOrder,
    setColorOrder,
    applyColorOrder,
    calibrateColorOrder,
    cycleColorOrder,
    applyPixelCount,
    connect,
    disconnect,
    command,
    push,
    refreshStatus,
  };
}
