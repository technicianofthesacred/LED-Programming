# Lightweaver card — install and run

This is a code-free worker checklist. Start at **[led.mandalacodes.com](https://led.mandalacodes.com)**. Do not type an IP address, search for a firmware file, or use a separate installer page.

If the screen does not match a step, stop and report what it says. Do not guess around a safety warning.

## Owner release check

Before handing the card to a worker, the owner must confirm that protected CI rebuilt and signed firmware after the latest firmware source change. A source change intentionally makes the freshness gate fail until CI publishes the new release.

Run:

```bash
cd lightweaver
npm run launch:check
npm run check:prod
```

Do not proceed if the factory binary is stale, signature/release verification fails, the production check fails, or `check:prod` was skipped because the machine was offline. Record the release firmware version, `buildId`, and source revision from the signed manifest/provenance.

## You need

- A laptop or desktop with current Chrome or Edge.
- The Lightweaver ESP32-S3 card.
- A USB data cable and stable card/LED power.
- Access to the Wi-Fi network the finished piece will use.

## Install Lightweaver

1. Plug in and power the card.
2. Open `led.mandalacodes.com` in Chrome or Edge.
3. Select **Connect Lightweaver**.
4. Choose **Blank or not responding**.
5. Select **Install Lightweaver**.
6. When the browser asks, choose the USB device that appeared when the card was connected.
7. Wait while Studio checks the card and verifies the official signed release.
8. Read the destructive confirmation, make sure the selected device is the Lightweaver card, and confirm installation.
9. Do not unplug the card while Studio erases, writes, verifies, and reboots it.

Success means Studio reports verified installation and continues to card setup. A flashing percentage or LEDs flickering by themselves are not sufficient proof.

## Connect and configure

1. Continue in the same Studio flow.
2. When instructed, open Wi-Fi settings and join `Lightweaver-XXXX`.
3. Return to Studio and press **Continue**.
4. Choose the venue/home Wi-Fi on the card-owned setup surface and enter its password.
5. Return to Studio after the card reboots.
6. Confirm Studio shows the expected card identity before changing GPIOs or LED counts.

The worker should never need to enter `192.168.4.1`, `lightweaver.local`, or a numeric LAN address.

## Verify real LEDs

1. Open Layout → Wire in Studio.
2. Check the GPIO/output shown for each physical connector.
3. Run the physical boundary test. Pixel 1 must be blue and the proposed final pixel must be red.
4. Use the nearby plus/minus controls until the red pixel is exactly the physical end; pixels beyond it must be dark.
5. Confirm direction, color order, and every separate output.
6. Lock wiring only after the real artwork matches Studio.
7. Choose several patterns. **Playing on Lightweaver** must appear only after the card changes. For several rapid choices, only the final choice should become the confirmed physical selection.

## Reconnect or recover

- If Studio loses the card, use the Card Status control and select **Reconnect**. Do not enter an IP.
- If the browser blocked the card page, allow the popup/local-network request and use the visible retry action.
- If the Studio preview changes but the LEDs do not, use **Reconnect** and then **Retry** beside the error.
- If the lights remain stuck or dark, use **Recover Lights** from Studio. Follow its result, then answer whether light is physically visible.
- If Studio routes back to USB installation/recovery, follow that guided flow. Do not choose an arbitrary firmware file.

## Stop and report

Stop immediately if:

- the signed release cannot be verified;
- the card identity or target does not match;
- Studio warns that firmware/configuration is too large or unsafe;
- installation loses power or USB connection;
- a wrong GPIO test does not roll back;
- Studio says **Playing on Lightweaver** but the physical output did not change; or
- recovery completes without visible light.

Report:

1. The exact on-screen message and action that failed.
2. The firmware version and `buildId` shown by Studio.
3. Whether the USB chooser saw the card.
4. What the LEDs physically displayed.
5. Whether `Lightweaver-XXXX` appeared.
6. Whether reconnect or Recover Lights received a card acknowledgement.

A photo of the failing screen and LEDs is more useful than a guessed explanation.
