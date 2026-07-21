export const FLASH_COMPLETE_RELEASED_STATUS = '● Flash complete, USB released';
export const FLASH_COMPLETE_RELEASED_LOG = 'Flash complete. USB released. Join the Lightweaver-XXXX WiFi network, then open http://192.168.4.1 if setup does not appear.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ESP32_S3_WDT = Object.freeze({
  protect: 0x600080b0,
  config1: 0x6000809c,
  config0: 0x60008098,
  key: 0x50d83aa1,
  resetConfig: 0xd0000102,
});

async function releaseSerialTransport(_loader, transport) {
  try {
    await transport?.disconnect?.();
  } catch {}
}

export async function resetEspIntoApp(transport, loader) {
  if (loader?.chip?.CHIP_NAME === 'ESP32-S3' && loader?.writeReg) {
    // Native USB-Serial/JTAG control lines cannot be changed atomically. On
    // real S3 hardware, a serial hard-reset sequence can briefly start the app
    // and then sample GPIO0 low again, leaving the ROM downloader active. The
    // RTC watchdog resets the chip without touching the USB boot straps.
    // Release GPIO0 before arming the watchdog so the ensuing hardware reset
    // cannot sample the download strap from whichever connect strategy won.
    await transport?.setDTR?.(false);
    await loader.writeReg(ESP32_S3_WDT.protect, ESP32_S3_WDT.key);
    await loader.writeReg(ESP32_S3_WDT.config1, 2000);
    await loader.writeReg(ESP32_S3_WDT.config0, ESP32_S3_WDT.resetConfig);
    await loader.writeReg(ESP32_S3_WDT.protect, 0);
    await sleep(700);
    return;
  }
  // Ask the ROM/stub loader to leave flash mode and run the application. This
  // is the same protocol operation as `esptool run`; unlike a sequence of
  // separate RTS/DTR pulses, it does not risk sampling GPIO0 low on the
  // ESP32-S3 USB-Serial/JTAG interface and returning to the downloader.
  if (loader?.flashBegin && loader?.flashFinish) {
    await loader.flashBegin(0, 0);
    await loader.flashFinish(false);
  }
  if (transport?.setDTR && transport?.setRTS) {
    // Match esptool's proven hard-reset exit: keep GPIO0 released, pulse EN,
    // and never add the extra pre-pulse transitions that can trigger the
    // ESP32-S3 USB-Serial/JTAG reset state machine twice.
    await transport.setDTR(false);
    await transport.setRTS(true);
    await sleep(200);
    await transport.setRTS(false);
    await sleep(200);
  }
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
