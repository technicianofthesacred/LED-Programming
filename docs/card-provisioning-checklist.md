# Lightweaver Card Provisioning — New Card Checklist

Use this checklist to commission a blank Lightweaver card for a customer. Follow each step in order; if anything goes wrong, note the failure and refer to the "Troubleshooting" section at the end.

---

## Part 1: Flash Firmware

### What you need
- A blank ESP32-S3 Lightweaver card
- A computer with Studio open (`led.mandalacodes.com` or local http://localhost:9999)
- A USB data cable

### Steps

**[ ]** Plug the card into the computer via USB cable (data, not power-only).

**[ ]** In Studio, open the **"Pair & Install"** panel on the left.

**[ ]** Click **"Choose USB card"**.

**[ ]** A dialog lists all connected USB devices. Select the correct card (labeled "Lightweaver" or "ESP32").

> **Stuck here?** If you see no devices, try unplugging and re-plugging the USB cable. If it still doesn't appear, the card may be in DFU mode already — proceed anyway.

**[ ]** Click **"Install current Lightweaver firmware"**.

**[ ]** Wait for the progress bar to finish. The status should change to **"Firmware installed, card ready"**.

> **Stuck here?** If the install times out or fails:
> - Note the error message.
> - Unplug the USB cable and wait 5 seconds.
> - Plug it back in and try again.
> - If it fails twice, the card may need recovery (see Troubleshooting).

**[ ]** Unplug the USB cable from the card. (Leave it plugged into the computer if running through Part 2 immediately; power the card separately if needed.)

---

## Part 2: Join the Card to Home WiFi

### What you need
- The card (unplugged from USB, powered on)
- A phone or laptop
- The home/gallery WiFi name (SSID) and password

### Steps

**[ ]** Power on the card (via barrel jack or USB power).

**[ ]** Wait 5 seconds for the card to boot.

**[ ]** On your phone/laptop, open the WiFi list. Look for a network named **"Lightweaver-XXXXX"** (where XXXXX is a code).

**[ ]** Join the Lightweaver network (no password required).

**[ ]** A web page should appear automatically (the captive portal). If not, open your browser and go to **`192.168.4.1`**.

**[ ]** On the captive portal:
  - Enter your home/gallery WiFi network name (SSID).
  - Enter the WiFi password.
  - Click **"Connect"**.

**[ ]** The portal shows **"Connected! Return to Studio"**.

**[ ]** Disconnect from the Lightweaver WiFi. Re-join your home network on your phone/laptop.

> **Optional:** The card will also show its IP address on the portal page. Note it if the card doesn't have mDNS support on your network.

**[ ]** In Studio, the card should automatically detect that it joined home WiFi and advance to the next step.

> **Stuck here?** If Studio doesn't auto-advance after 30 seconds:
> - Click **"Try again"** in Studio.
> - If the card still doesn't appear, note the card's IP address from the portal and enter it manually in Studio's **"Card address"** field.

---

## Part 3: Pair the Card in Studio

### What you need
- The card now on home WiFi
- Studio (same network)

### Steps

**[ ]** In Studio, the status should show **"Found — pair"** or **"Card is blank"**.

**[ ]** Click **"Connect"** (or **"Install project"** if the card is blank).

**[ ]** Studio displays the card's name and ID. Verify it matches the label on the card.

**[ ]** Click **"Pair this card"** to confirm.

**[ ]** Status changes to **"Paired — send project"**.

> **Stuck here?** If pairing fails:
> - Check that the card is still on the home WiFi (join the Lightweaver AP again if needed to verify the card is reachable).
> - Try unplug/replug the card's power and pair again.

---

## Part 4: Install the Project

### What you need
- The paired card
- A Lightweaver project already open in Studio (strips, zones, wiring configured)

### Steps

**[ ]** In Studio, with the card paired, click **"Install your project"** (or **"Send to card"**).

**[ ]** Status shows **"Installing…"** for a few seconds.

**[ ]** Status changes to **"Project installed"** and shows a revision number.

> **Stuck here?** If the install fails:
> - Check the error message in Studio.
> - Power-cycle the card (unplug 5 seconds, plug back in).
> - Try installing again.
> - If it fails twice, the card may need recovery (see Troubleshooting).

---

## Part 5: Light Check (Verify Wiring)

### What you need
- The card with project installed
- The physical LED strip wired to the card's GPIO output
- Power for the LED strip (barrel jack or battery)

### Steps

**[ ]** In Studio, with the project installed, click **"Test lights"** (or **"Wire & Test"**).

**[ ]** A panel shows the available GPIO outputs. Select the GPIO where you wired the LED strip.

**[ ]** Click **"Send test pattern"**.

**[ ]** Watch the LED strip. You should see:
  - **Success:** The strip lights up with a dim pulse or test color.
  - **No lights:** The wiring is on the wrong GPIO or the strip is not powered.

**[ ]** If the strip lit up:
  - Click **"Lights confirmed"** in Studio.
  - Status changes to **"Ready to hand off"**.

**[ ]** If the strip didn't light up:
  - Click **"Try a different GPIO"** and test each GPIO until you find the right one.
  - Once you find it, update the project in Studio to use the correct GPIO.
  - Send the project to the card again and re-run the light test.

> **Stuck here?** If no GPIO lights the strip:
> - Check that the LED strip is powered and the power connector is secure.
> - Check that the GPIO pin and GND are securely connected to the strip.
> - Verify the strip's data line is connected (usually a 3-wire or 4-wire connector).
> - Power-cycle the card and try again.

---

## Part 6: Handoff

### What you need
- The verified card (project installed, lights working)
- The printable "Lightweaver Handoff Card" (a QR code + recovery instructions)

### Steps

**[ ]** Print a copy of the handoff card (see the template in Lightweaver docs).

**[ ]** Write the card's name (from Studio) and the WiFi SSID on the card.

**[ ]** Hand both the card and the printable handoff to the customer.

**[ ]** Explain briefly:
  - "Join the WiFi network listed on this card."
  - "Scan the QR code to access the support page."
  - "Visit led.mandalacodes.com if you ever need help."

---

## Troubleshooting

### Card doesn't appear as a USB device after flashing
- **First try:** Unplug USB, wait 5 seconds, plug back in.
- **Second try:** Use a different USB port or cable.
- **If still stuck:** The card may be in DFU bootloader mode (a recovery state). Try the recovery procedure below.

### Firmware installation keeps timing out
- Check the USB cable is a **data cable** (power-only cables don't work).
- Try a different USB port on the computer.
- If the install completes but the card doesn't respond afterward, see **"Card doesn't appear on WiFi"** below.

### Card doesn't appear on WiFi after flashing
- **First try:** Wait 30 seconds after unplugging USB for the card to boot.
- **Second try:** Power-cycle the card (unplug barrel jack, wait 5 seconds, plug back in).
- **If still stuck:** The card may have corrupted firmware. Try re-flashing via USB.

### Studio shows **"Card stopped responding"** after it was working
- The WiFi connection dropped. Power-cycle the card and wait for Studio to re-connect automatically (30 seconds).
- If it doesn't reconnect, check that the home WiFi is still running and the card can reach it.

### LED strip doesn't light up during the test
- Verify the strip is powered (check the barrel jack or battery).
- Try each GPIO in turn (see Part 5 step 3).
- Verify the GPIO pin and GND are soldered securely to the strip's pads.
- Check the data line is connected (if the strip has three or four wires).
- If none of these work, the strip may have failed — try a replacement.

### Card was working but then stopped after a few days
- This is likely a WiFi connectivity issue, not a card failure.
- Power-cycle the card (unplug for 10 seconds, plug back in).
- If the customer moved the card, they may need to re-join the WiFi via the captive portal.
- Check the WiFi network is still running and stable.

### "Card needs recovery" message in Studio
- The card's project got corrupted (rare). Follow these steps:
  1. Unplug the card's power for 10 seconds.
  2. Plug it back in and wait 5 seconds.
  3. In Studio, click **"Recover card"** and follow the prompts.
  4. The card will erase its stored project and return to factory defaults.
  5. Go back to **Part 3** (pair the card) and re-install the project.

---

## Success

When you reach the end of **Part 6**, the card is ready for the customer. The green status in Studio confirms:
- ✅ Firmware installed and verified
- ✅ Paired to this Studio instance
- ✅ Project installed and readable
- ✅ Wiring tested and working
- ✅ LEDs light up correctly

Hand off the card and the printable recovery card. The customer's first experience should be: join WiFi, see the support page, and admire the lights.

