# Lightweaver customer runtime

Start every setup, design, connection, install, update, and recovery flow at **[led.mandalacodes.com](https://led.mandalacodes.com)**. The website is the only address a customer needs to remember.

The ESP32 card owns playback after setup, so ordinary daily use remains available without internet. That offline independence is runtime behavior, not a separate onboarding path.

## The normal customer flow

1. Open `led.mandalacodes.com`.
2. Select **Connect Lightweaver**.
3. Choose what is physically true: **My card already lights up** or **Blank or not responding**.
4. Follow the single action Studio presents for this browser and card.
5. Confirm the real card before Studio enables hardware changes.

Studio remembers the card's stable ID and unique hostname. Numeric addresses are replaceable hints only. If a different card answers, Studio refuses the mutation and offers **Reconnect expected card** or the explicit **Use this card instead** action.

## A working card

For a card that already lights:

- Studio reconnects a previously paired card when possible.
- If setup Wi-Fi is required, Studio tells the person to power the card, join `Lightweaver-XXXX`, return to Studio, and press **Continue**.
- Browser popup or local-network permission is requested only from that click. If it is blocked, the same Connection Center offers a retry.
- Wi-Fi credentials are entered on the card-owned setup surface and never sent to the public origin.

The customer returns to Studio after setup. They are not expected to type `192.168.4.1`, `lightweaver.local`, or a numeric LAN address.

## A blank or damaged card

For a blank or non-responsive card, Studio presents **Install Lightweaver** when the browser exposes the required secure Web Serial capability. The normal installer:

- requests the USB device from an explicit click;
- performs a non-destructive identity/flash-size check;
- downloads only the official signed production release;
- verifies its target, signature, immutable path, digest, size, version policy, and provenance;
- asks for the final destructive confirmation;
- writes and verifies the image; and
- continues into connection and physical setup.

The customer does not choose a firmware file, flash address, baud rate, or arbitrary erase option. Unsupported browsers receive one valid browser/device handoff rather than a dead-end error.

## Design and physical verification

Studio preview and physical playback are separate:

- **Previewing in Studio** means only the browser preview changed.
- **Sending to Lightweaver** means the newest intent is pending.
- **Playing on Lightweaver** appears only after the expected card acknowledges the applied preview.

Rapid changes use one latest-only queue. A superseded response cannot move the physical selection backward. If acknowledgement fails, Studio keeps the prior confirmed physical state and says exactly:

> The Studio preview changed, but the physical lights did not. Reconnect and retry.

The failure stays beside the action with **Reconnect** and **Retry**.

Before wiring is locked, the person verifies each output on the real artwork: pixel 1 is blue, the proposed last pixel is red, pixels outside the boundary remain dark, GPIO and direction match the wire, and an unconfirmed wiring candidate rolls back automatically.

## One recovery flow

Begin recovery at `led.mandalacodes.com` and open the Card Status control. **Recover Lights** releases temporary streams and diagnostics, restores confirmed wiring/configuration where possible, restarts only when required, and reports whether the card acknowledged recovery. The UI still asks the person to confirm that light is physically visible; software acknowledgement cannot fabricate that observation.

If ordinary browser recovery cannot reach a deeply damaged card, Studio routes back to the supported USB install/recovery path. Local URLs remain technician diagnostics, not customer instructions.

## Standalone playback modes

### Internal flash

After setup, the card starts from internal flash with its saved outputs, limits, looks, and control mappings. No website, laptop, Pi, or memory card is required for playback.

### MicroSD sequence

An optional microSD card can provide larger recorded sequences:

```text
/lightweaver.json
/sequences/*.lwseq
```

Boot priority is:

1. valid microSD package;
2. valid internal-flash configuration;
3. compiled factory defaults.

### Future live host

Laptop/Pi/Madrix/sound-reactive streaming is an advanced future lane. A Raspberry Pi is not part of the current customer runtime.

## Technician diagnostics only

When a customer flow has already failed, a technician may inspect `GET /api/status` at a confirmed card-local address, compare stable card ID/build ID/GPIO/counts, and use the deployment checklist. Direct local URLs are never printed as the primary customer path and must never be treated as identity.
