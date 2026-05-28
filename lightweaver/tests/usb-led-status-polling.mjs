import assert from 'node:assert/strict';
import {
  USB_LED_CONNECTED_POLL_MS,
  USB_LED_RECOVERY_POLL_MS,
  getUsbLedStatusPollInterval,
} from '../src/lib/usbLedStatusPolling.js';

assert.equal(
  getUsbLedStatusPollInterval({ connected: true, connecting: false }),
  USB_LED_CONNECTED_POLL_MS,
);

assert.equal(
  getUsbLedStatusPollInterval({ connected: false, connecting: false }),
  USB_LED_RECOVERY_POLL_MS,
  'disconnected browser state must keep polling so it can recover when the bridge is already connected',
);

assert.equal(
  getUsbLedStatusPollInterval({ connected: false, connecting: true }),
  null,
);

console.log('usb-led-status-polling tests passed');
