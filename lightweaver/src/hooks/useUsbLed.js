import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LWUSB_MAX_PIXELS,
  DEFAULT_LWUSB_PUSH_FPS,
  getLwUsbSerialSafeFps,
  normalizeLwUsbPixelCount,
  pixelsToLwUsbFrameHex,
} from '../lib/usbLedFrame.js';
import { makeUsbLedColorOrderCommand, normalizeUsbLedColorOrder } from '../lib/usbLedColorOrder.js';

const USB_PUSH_FPS_KEY = 'lw_usb_push_fps';
const USB_COLOR_ORDER_KEY = 'lw_usb_color_order';

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
  const [colorOrder, setColorOrderState] = useState(() => normalizeUsbLedColorOrder(localStorage.getItem(USB_COLOR_ORDER_KEY)));
  const lastPushRef = useRef(0);
  const pushInFlightRef = useRef(false);

  const setColorOrder = useCallback((value) => {
    const next = normalizeUsbLedColorOrder(value);
    setColorOrderState(next);
    localStorage.setItem(USB_COLOR_ORDER_KEY, next);
    return next;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await requestUsbLed('status', { timeoutMs: 1200 });
      setStatus(next);
      setConnected(!!next.connected);
      if (next.colorOrder) setColorOrder(next.colorOrder);
      setLastError(next.lastError || '');
      return next;
    } catch (error) {
      setConnected(false);
      setLastError(error.message);
      return null;
    }
  }, [setColorOrder]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const connect = useCallback(async ({ pixelCount, brightness = 64, portPath, colorOrder: requestedOrder } = {}) => {
    setConnecting(true);
    setLastError('');
    try {
      const next = await requestUsbLed('connect', {
        method: 'POST',
        body: {
          portPath,
          pixelCount: normalizeLwUsbPixelCount(pixelCount, { maxPixels: status?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS }),
          brightness,
          colorOrder: normalizeUsbLedColorOrder(requestedOrder || colorOrder),
        },
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
  }, [colorOrder, setColorOrder, status?.maxPixels]);

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
  }, [setColorOrder]);

  const applyColorOrder = useCallback(async (value) => {
    const nextOrder = setColorOrder(value);
    const result = await command(makeUsbLedColorOrderCommand(nextOrder));
    return result;
  }, [command, setColorOrder]);

  const applyPixelCount = useCallback(async (value) => {
    return command(`COUNT ${normalizeLwUsbPixelCount(value, { maxPixels: status?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS })}`);
  }, [command, status?.maxPixels]);

  const push = useCallback((pixels) => {
    if (!connected || pushInFlightRef.current) return;
    const now = performance.now();
    const hex = pixelsToLwUsbFrameHex(pixels, { maxPixels: status?.maxPixels || DEFAULT_LWUSB_MAX_PIXELS });
    if (!hex) return;

    const configuredFps = Number(localStorage.getItem(USB_PUSH_FPS_KEY)) || DEFAULT_LWUSB_PUSH_FPS;
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
    applyPixelCount,
    connect,
    disconnect,
    command,
    push,
    refreshStatus,
  };
}
