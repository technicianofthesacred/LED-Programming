export const USB_LED_CONNECTED_POLL_MS = 250;
export const USB_LED_RECOVERY_POLL_MS = 1000;

export function getUsbLedStatusPollInterval({ connected = false, connecting = false } = {}) {
  if (connecting) return null;
  return connected ? USB_LED_CONNECTED_POLL_MS : USB_LED_RECOVERY_POLL_MS;
}
