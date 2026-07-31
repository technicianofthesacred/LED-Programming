# Lightweaver hardware setup

This is the current ESP32-S3 card setup path. It requires a computer with a
supported USB browser, a data-capable USB cable, the final LED power supply, and
eyes on the physical strip.

Do not install WLED on a current Lightweaver card. WLED, Raspberry Pi hosting,
and Madrix commissioning are deferred lanes documented separately in
[`deferred-wled-hardware-setup.md`](deferred-wled-hardware-setup.md).

## 1. Prepare the bench

1. Disconnect LED power before changing wiring.
2. Connect the ESP32-S3 card to the computer with a data-capable USB cable.
3. Wire LED data only to a production-supported output: GPIO 16, 17, 18, or 21.
4. Connect controller ground and LED power-supply ground.
5. Power the LEDs from their final supply, not from USB.
6. Start with the Studio brightness limit at a safe bench level.

## 2. Install signed Lightweaver firmware

1. Open [led.mandalacodes.com](https://led.mandalacodes.com) in a supported
   desktop browser.
2. Open **Card**, then **Install or update**.
3. Connect the exact ESP32-S3 card when the browser asks.
4. Let Studio inspect the target and signed release.
5. Confirm the destructive erase only after Studio shows the expected card.
6. Keep the USB cable connected until write verification and application restart
   complete.

The normal installer chooses the image, flash layout, baud rate, and offsets.
Do not select a local binary or flash the public factory image manually unless
the supported installer has failed and the deployment checklist explicitly
directs technician recovery.

## 3. Join the card setup network

After the card restarts:

1. Join the card network named `Lightweaver-XXXX`.
2. Return to Studio and continue the same setup.
3. Enter gallery or studio Wi-Fi credentials only on the card-owned page.
4. Wait for Studio to verify the same card on the local network.

The normal customer path does not require typing `192.168.4.1`,
`lightweaver.local`, or a numeric LAN address. Manual local addresses belong
under **Connection help** after automatic discovery fails.

## 4. Load the project

Open **Test & Install**. Before any hardware change, review:

- **Card:** the paired Lightweaver identity.
- **Wiring:** output pins, physical pixel counts, direction, and color order.
- **Power:** the selected supply and deployed current limit.
- **Playback:** startup look, saved looks, and playlist.

Studio keeps **Saved in Studio** separate from **Installed on card**. A send is
not an installation until the exact card independently reads the project back.

## 5. Test the physical lights

Hardware changes enter the safe test path. Playback-only changes use the shorter
verified update.

1. Read the photosensitivity warning before starting chase, flash, or color
   tests.
2. Keep **Stop lights** available throughout the test.
3. Confirm the first physical pixel.
4. Confirm the proposed final pixel and that the next pixel stays dark.
5. Confirm direction using position and motion, not color alone.
6. Confirm red, green, and blue in sequence and select the correct color order.
7. Confirm each output boundary before moving to the next output.

Until confirmation, the previous working setup remains stored. If the physical
result is wrong, restore it and return to **Wire**. Do not approve a candidate
because Studio sent it successfully.

## 6. Verify offline playback

Studio must finish with **Installed and verified** on the named card. Then:

1. Play the first scene and confirm visible output.
2. Disconnect Studio and confirm local controls still work.
3. Power the card and LEDs off.
4. Power them back on and confirm the same startup look, brightness limit,
   wiring, and playlist.
5. Disconnect the gallery network and confirm offline playback continues.
6. Restore the network and confirm Studio reconnects to the same card.

For microSD projects, also confirm the declared sequence loads, plays through,
and fails safely when the card is removed or corrupted.

## 7. Record the acceptance result

Complete the pass record required by
[`new-card-checklist.md`](new-card-checklist.md). Record the stable card ID,
firmware build, project fingerprint, output boundaries, color order, power
limit, power-cycle result, offline result, and Wi-Fi recovery result.

The card is not ready to ship until the physical observations in
[`deployment-checklist.md`](deployment-checklist.md) are complete. Automated
tests and firmware acknowledgements cannot replace them.
