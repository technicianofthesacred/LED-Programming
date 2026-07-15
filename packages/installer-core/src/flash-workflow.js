export const FLASH_COMPLETE_RELEASED_STATUS = '● Flash complete, USB released';
export const FLASH_COMPLETE_RELEASED_LOG = 'Flash complete. USB released. Join the Lightweaver-XXXX WiFi network, then open http://192.168.4.1 if setup does not appear.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function releaseSerialTransport(_loader, transport) {
  try {
    await transport?.disconnect?.();
  } catch {}
}

export async function resetEspIntoApp(transport) {
  if (!transport?.setDTR || !transport?.setRTS) return;
  // GPIO0 high (DTR false), pulse EN low/high (RTS true -> false). The
  // esptool-js hard_reset helper only releases RTS, which can leave an S3 board
  // sitting after a browser flash until the user manually presses RESET.
  await transport.setDTR(false);
  await transport.setRTS(false);
  await sleep(50);
  await transport.setRTS(true);
  await sleep(120);
  await transport.setRTS(false);
  await transport.setDTR(false);
  await sleep(900);
}

export async function flashFirmwareAndRelease({
  loader,
  transport,
  file,
  address,
  eraseAll,
  onProgress,
  flashFirmware,
  resetESP = resetEspIntoApp,
  disconnectESP = releaseSerialTransport,
}) {
  if (typeof flashFirmware !== 'function') {
    throw new Error('flashFirmware dependency missing');
  }

  try {
    await flashFirmware(loader, file, address, eraseAll, onProgress);
    await resetESP(transport, loader).catch(() => {});
  } finally {
    // Always release the serial transport, even if the write fails partway
    // through, so the port isn't left held open after an error.
    await disconnectESP(loader, transport);
  }
}
