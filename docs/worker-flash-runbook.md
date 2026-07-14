# Lightweaver card — flash & run (worker runbook)

A code-free checklist for getting a Lightweaver card running by flashing it from
**led.mandalacodes.com** (Studio opens directly at the root). No programming needed. If a step doesn't match what you
see, **stop and report exactly what's on screen** — don't guess.

> **Before the worker starts (owner check):** make sure the website is serving the
> **current** firmware. The card only behaves as well as the binary on the site.
> If firmware was changed recently, rebuild and redeploy first
> (`firmware/lightweaver-controller/scripts/build-factory-bin.sh`, then
> `cd lightweaver && npm run deploy:pages`). Otherwise flashing just reinstalls
> old firmware — the "works but not fully" trap.

## You need
- A **laptop or desktop** running **Chrome or Edge** (the flasher uses Web Serial —
  this does **not** work on a phone, or in Safari/Firefox).
- The Lightweaver card and its **USB cable**.
- A phone with WiFi (to finish setup).

## Flash the card
1. Plug the card into the computer with the USB cable.
2. Open **led.mandalacodes.com** in Chrome/Edge.
3. Find the **flash / install firmware** tool and choose the **Lightweaver factory
   firmware** option (it should select itself and show a file name ending in
   `-factory.bin`). Leave **Erase all** checked.
4. Click **Flash**. A browser popup asks you to pick a serial port — choose the one
   that appears when the card is plugged in (often "USB JTAG" / "CP210x" / "ESP32").
5. Wait. It erases (~15s) then writes for a minute or two. **Don't unplug.** When it
   says done / it reboots, flashing is complete.

✅ **Success looks like:** the progress reaches 100% and reports done, and the card's
LEDs do something (light up or flicker) after it reboots.

## Connect it to WiFi
6. On your phone, open WiFi settings. Join the network named **`Lightweaver-XXXX`**
   (XXXX is letters/numbers). It has no password.
7. A setup page should open automatically (if not, open a browser — it appears).
8. Pick the venue/home WiFi, enter its password, and save. The card reboots and joins
   that network.

✅ **Success looks like:** after it reboots, the LEDs run a pattern, and the
`Lightweaver-XXXX` network disappears (because the card is now on the real WiFi).

## If something's off — quick recovery (still no code)
- **No `Lightweaver-XXXX` network appears** → unplug the card, wait 5s, plug back in,
  wait 30s, look again.
- **LEDs stay dark or look wrong (wrong colors/half lit)** → re-flash (repeat *Flash
  the card* with **Erase all** checked). If still wrong, it's likely **wiring/power**,
  not the flash — report it.
- **Flash popup shows no serial port** → try a different USB cable (some are
  charge-only) and a different USB port, then retry from step 1.
- **It joined the wrong WiFi / you mistyped the password** → unplug/replug; if the
  `Lightweaver-XXXX` network comes back, redo *Connect it to WiFi*. If it doesn't,
  report it (a WiFi reset may be needed).

## What to report back to Adrian
You can't debug code, but these observations are exactly what's useful:
1. Did flashing reach **100% / done**? Any red error text? (copy it or photo it)
2. After reboot, **what did the LEDs do** — nothing, flicker, steady, a moving pattern?
3. Did **`Lightweaver-XXXX`** appear, and did the setup page open?
4. After entering WiFi, did the LEDs start a pattern and the setup network go away?

A photo of the screen at any failing step is worth more than a description.
