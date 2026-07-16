# Lightweaver workshop card setup

This is the no-code procedure for preparing one sellable Lightweaver card and artwork. Start and finish each artwork in **Production setup** at [led.mandalacodes.com](https://led.mandalacodes.com/#screen=production). Do not use `/design`, a local IP address, the Lightweaver Bridge, a terminal, or a firmware file from a message or download folder.

## Before each card

Have these ready:

- A desktop or laptop running current Chrome or Edge. Phones, Safari, and Firefox cannot do the USB step.
- Internet access and the secure `https://led.mandalacodes.com/#screen=production` page.
- One Lightweaver ESP32-S3 card connected with a known USB **data** cable. Disconnect every other Lightweaver card.
- The powered artwork and its printed job label. The label may provide a QR address or job code. A QR is only a shortcut to the website; it does not install anything itself.
- The card and LED power disconnected while changing physical wires. USB may power the controller, but it does not prove the LED power supply is connected.

Quick data-cable check: after connecting the cable, the computer's USB chooser must show an ESP32/serial device. If the card receives power but no device appears, change the cable before changing any software or wiring.

## Prepare one artwork

1. Open `https://led.mandalacodes.com/#screen=production` in desktop Chrome or Edge.
2. Choose the artwork from the verified list. If the printed QR already opened the job, confirm its artwork and batch. Otherwise enter the printed **Job code**. If the workshop list is unavailable, choose both signed files supplied together: the `.lwjob.json` job and matching `.sig.json` signature. Studio rejects an unverified or mismatched file.
3. Wait for **Job and official firmware are verified**. Do not connect USB until **Connect one USB card** is enabled. This preloads the exact signed firmware before any local-card network handoff.
4. Click **Connect one USB card**. In Chrome's chooser, select the single ESP32-S3 card. If more than one appears, cancel, unplug the extras, and retry.
5. Click **Release USB and inspect firmware**. Follow the one primary action Studio shows. The local card page may open while Studio reads the card; return to the Production setup tab when instructed.
6. If Studio proves the exact firmware is already present, continue. If it shows **Install verified firmware**, reconnect the same USB card and click that button. Never browse for a firmware file. Wait until Studio says USB is released and the card has restarted.
7. Click **Reconnect same card**. If Studio identifies a different card, stop and reconnect the expected card shown on screen. Do not adopt or substitute another card during this run.
8. Click **Load verified artwork** once, then **Verify card read-back**. A successful upload message alone is not a pass; Studio must independently read the same card, firmware build, job digest, and artwork revision back from the card.

## Check the real LEDs

For every boundary tab, look at the physical artwork—not the browser preview:

- The first included pixel is **blue**.
- The displayed final pixel number is **red**.
- Pixels between them use the dim test light.
- Every other output and every pixel outside this boundary stays **dark**.
- Only the named output/GPIO lights.

If all of those facts are true, click **Yes, this boundary is correct**. Repeat for every boundary.

If not, choose the exact observation shown on screen: **Nothing lit**, **Colors wrong**, **Blue / red swapped**, **Red end is off**, **Wrong strip lit**, or **Flashing or frozen**. Use only the correction Studio offers. Pixel count uses **− 1 pixel** or **+ 1 pixel**; direction, color order, and GPIO use a temporary 90-second candidate.

While a temporary candidate is active:

- Confirm it only after the real boundary is correct; confirming saves that exact candidate.
- To reject it, click **Restore last confirmed wiring**.
- If time expires, the card rolls back automatically.
- If Studio cannot prove rollback, do not unplug or continue. Keep the candidate screen open and escalate with its support code.

Never pass a card because Studio says the test was delivered. Delivery only means the card acknowledged the frame; a worker must see and confirm every boundary.

## Record and move to the next artwork

1. Click **Continue to pass record** only after every boundary has a physical check mark.
2. Enter your worker initials or workshop ID and click **Save pass record**.
3. Under **Pass records**, export **CSV** at the end of each batch and **JSON** as the audit backup. Unexported records exist only in this browser and can be lost if its data is cleared or the computer changes.
4. Confirm the downloaded files are present in the workshop's batch folder.
5. Click **Next artwork**. This keeps completed records but clears the prior job, card, USB, commissioning, and light-test state. Disconnect the finished card before connecting the next one.

## If Studio stops safely

Read the **Safe recovery** panel before touching USB. It states what happened, whether the card changed, whether USB is released, one safest action, and a support code. Use that one action; repeatedly flashing or reloading can make diagnosis harder.

Common codes:

| Code | Meaning | First action |
|---|---|---|
| `LW-USB-101` | No USB data connection / likely charge-only cable | Use a known data cable and reconnect |
| `LW-USB-102` | Port busy | Close other browser tabs and serial tools, then retry |
| `LW-USB-103` | Linux USB permission blocked | Ask the workshop lead to fix the device permission, then retry |
| `LW-USB-104` | USB serial driver missing | Ask the workshop lead to install the card driver |
| `LW-USB-105` | More than one possible card | Leave only one card connected |
| `LW-USB-106` | Unsupported card | Connect a supported Lightweaver ESP32-S3 card |
| `LW-CARD-201` | Wrong card reconnected | Reconnect the expected card shown by Studio |
| `LW-CARD-202` | Card page could not be read | Reconnect the expected card page |
| `LW-LOAD-301` | Load response was interrupted | Verify card read-back; do not load again blindly |
| `LW-LOAD-302` | Read-back does not match the job | Use **Retry verified artwork load** once |
| `LW-LIGHT-401` | Physical observation failed | Run the safe light check again |
| `LW-FW-501` | Official signed release could not be verified | Retry verified firmware after checking internet access |

For any unresolved stop, click **Export support details** and send that small JSON file plus the support code to the workshop lead. It excludes the artwork, worker, card identity, network details, and raw error. Also report, in plain words: whether the card's status LED is on, whether any artwork pixels are lit, and which boundary observation failed. Do not send firmware files, screenshots containing private network details, or browser storage.

## Workshop lead escalation

Quarantine the card and artwork when the same support code returns after its one safe action, rollback cannot be proven, the wrong output lights after a verified GPIO correction, or power/data wiring is physically damaged. Keep its exported support JSON and latest batch CSV/JSON together. A card is not ready for sale until the Production setup screen records a pass from the real powered artwork.
