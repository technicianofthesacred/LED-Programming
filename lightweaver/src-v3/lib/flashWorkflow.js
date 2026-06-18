export const FLASH_COMPLETE_RELEASED_STATUS = '● Flash complete, USB released';
export const FLASH_COMPLETE_RELEASED_LOG = 'Flash complete. USB released. Join the Lightweaver-XXXX WiFi network, then open http://192.168.4.1 if setup does not appear.';

async function releaseSerialTransport(_loader, transport) {
  try {
    await transport?.disconnect?.();
  } catch {}
}

export async function flashFirmwareAndRelease({
  loader,
  transport,
  file,
  address,
  eraseAll,
  onProgress,
  flashFirmware,
  disconnectESP = releaseSerialTransport,
}) {
  if (typeof flashFirmware !== 'function') {
    throw new Error('flashFirmware dependency missing');
  }

  await flashFirmware(loader, file, address, eraseAll, onProgress);
  await disconnectESP(loader, transport);
}
