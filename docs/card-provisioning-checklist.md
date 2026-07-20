# Lightweaver new-card checklist

Use this checklist for every card. Work on **one card at a time** in desktop Chrome or Edge. The operator—not Studio—must look at the real LEDs and answer the light-check questions.

## Before starting

- [ ] Open the verified artwork/job in Lightweaver Studio.
- [ ] Disconnect every other Lightweaver card from USB and power.
- [ ] Connect the LED strip to its correct power supply. USB power for the ESP32 does **not** power a 12 V strip.
- [ ] Check that card ground and LED-power ground are connected, and that data goes to the strip's **DATA IN** end.
- [ ] Keep the finished card's label available so you can compare its card ID.

**STOP:** Do not improvise when Studio shows **Checking card**, **Found — pair**, **Needs project**, **Card stopped responding**, **Wrong card**, or a recovery code. None of those means ready.

## 1. Select and flash the exact USB card

- [ ] In Studio, open **Production setup** and wait for the artwork and official signed firmware to be verified.
- [ ] Click **Connect one USB card**. In the browser chooser, select the only ESP32-S3 shown.
- [ ] Confirm Studio displays the card ID you intend to build. If more than one USB card appears, cancel and disconnect the others.
- [ ] Follow the displayed action. If Studio offers **Install verified firmware**, reconnect the same USB card and install it.
- [ ] Wait through USB release and restart. A completed progress bar proves only that bytes were transferred.
- [ ] Continue only after Studio reads the same card ID and the exact signed firmware version/build back from the restarted card.

**STOP:** Wrong/missing card ID, wrong firmware build, interrupted flash, unconfirmed USB release, or a transfer without post-restart read-back is not a successful flash.

## 2. Witness the blank-card beacon and set up Wi-Fi

- [ ] With LED power on, watch for **eight dim amber pixels, two short pulses**. A blank card cycles the safe outputs, so allow about 10 seconds for two complete cycles.
- [ ] Treat this only as proof that the blank firmware, strip power, common ground, and a supported data path are alive. The ESP32's green board LED proves power only.
- [ ] Confirm Studio says **Blank — load a project** or **Needs project**. A factory card must never be shown as green/connected-ready.
- [ ] Join the card's `Lightweaver-XXXX` Wi-Fi and open `http://192.168.4.1` if the setup page does not appear automatically.
- [ ] Enter the workshop/gallery Wi-Fi details. When the setup hotspot drops, return the computer to that same workshop/gallery network.
- [ ] Leave Studio open. It should find the **same card ID** on the LAN and continue automatically.
- [ ] If automatic return times out, enter the card's shown hostname or IP in **Card address**, reopen the card page, and retry. Do not keep using `192.168.4.1` after the card has left setup mode.

**STOP:** No amber beacon after two complete cycles, failure to rejoin the LAN, or a different card ID requires recovery. Do not call the green board LED a light-test pass.

## 3. Find, then pair, the LAN card

- [ ] If Studio says **Found — pair**, compare the displayed card ID with the USB-inspected ID and the physical label.
- [ ] Only after all three match, click **Connect** / **Pair this card**.
- [ ] Pairing and discovery are separate facts: **Found — pair** means reachable but unpaired, not connected and not command-ready.
- [ ] After pairing, confirm the card still says **Blank — load a project** / **Needs project** until its project is independently installed and read back.

**STOP:** Never adopt a different discovered card to finish the current run. Reconnect the expected card instead.

## 4. Load the project and discover the LED output

- [ ] Click **Load verified artwork** / **Install your project** once.
- [ ] Wait for Studio's independent read-back of the same card ID, firmware build, job/project revision, fingerprint, and wiring revision. A POST/upload acknowledgement alone is not a pass.
- [ ] Start **Find LED wire**. Studio tests the approved outputs one at a time, in this order:

  1. GPIO 16
  2. GPIO 17
  3. GPIO 18
  4. GPIO 21

- [ ] For each pin, look at the real strip and answer **This strip lit** or **No light**. At most one pin is driven at a time; do not skip ahead or enter an unlisted GPIO.
- [ ] Record the first pin that produces the eight-pixel, two-pulse amber signal. Continue with only that pin.

**STOP:** If none of GPIO 16/17/18/21 lights, check strip voltage, common ground, DATA IN direction, and connectors. Do not save a guessed pin.

## 5. Test the temporary project, then confirm it

- [ ] Let Studio stage the project with the observed GPIO and reboot the card into its temporary **90-second test**. This is probation, not known-good.
- [ ] Wait for the exact staged candidate and activation ID to be read back after restart.
- [ ] Inspect the **full physical strip**: first pixel blue, last expected pixel red, dim pixels between, correct length, direction, colors, and only the intended output lit.
- [ ] If every visible fact is correct, click **Yes, this boundary is correct** / **Lights confirmed** before the timer ends.
- [ ] Wait for Studio to read the exact wiring back as **known-good**. The human **yes** is required; Studio has no light sensor and cannot see the strip.
- [ ] If anything is wrong, choose the matching on-screen failure. Let Studio roll back or click **Restore last confirmed wiring**. Repeat the test; never confirm merely because Studio says a frame was delivered.

**STOP:** A staged/testing candidate, expired timer, unproven rollback, wrong color/count/direction/output, flashing/frozen strip, or partial illumination is not shippable.

## 6. Prove restart and live command readiness

- [ ] Power the card and strip off, wait five seconds, then power them on again.
- [ ] Confirm the full project returns automatically on the same physical strip.
- [ ] Wait while Studio changes from **Card restarted — verifying** / **Checking card** to its final ready state.
- [ ] Studio must receive **two stable, complete readiness checks** for the same card, new boot, signed firmware build, known-good project, and initialized output.
- [ ] Run the final harmless light command and require its acknowledgement from that exact card/boot/output. Look at the strip and confirm it visibly responds.
- [ ] Save the pass record only after Studio enables completion and every physical boundary is checked.

**STOP:** If the card resets, disappears, changes boot again, loses the card page, returns blank, or fails the command acknowledgement, Studio must demote it. Reconnect and repeat this section; never accept a stale green state.

## 7. Finish this card and clear the station

- [ ] Confirm the pass record contains the expected card ID, signed firmware build, job/project identity, known-good wiring, GPIO, pixel count, and physical confirmations.
- [ ] Label and pack the card only while Studio shows the verified ready/pass state.
- [ ] Click **Next Card** (older builds may say **Next artwork**).
- [ ] Confirm the previous card ID, boot ID, command/activation acknowledgements, observations, recovery state, and green status are gone. In batch mode, only the selected immutable job may remain.
- [ ] Disconnect the finished card before connecting the next blank card.

## LAN control path

- Public Studio at `https://led.mandalacodes.com` controls a LAN card through the card page's HTTPS-to-local bridge. Keep that local card page open; reopening a page does not itself prove pairing or readiness.
- Studio served locally over plain `http` can use direct HTTP to the card. It must pass the same identity, two-envelope readiness, read-back, and command-acknowledgement gates.
- USB flashing must run in the secure top-level Production setup page. Neither transport may turn reachability alone into **Connected** or **Success**.

The card is ready to ship only when the real strip passed the full visual test after a power cycle, the exact configuration is known-good, Studio verified stable readiness, and the final command was acknowledged.
