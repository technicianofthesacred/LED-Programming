# New Lightweaver card checklist

Run this once for every card in desktop Chrome or Edge at
`https://led.mandalacodes.com/#screen=production`. Use one card, one powered
44-pixel bench strip, and one USB data cable. Do not use a terminal, type a card
address, or recover outside the guided screen.

Write the canonical card ID shown by Studio: `lw-________________`

For the current labeled bench card, Studio must show `lw-b0fe81f61b44`.
`lw-441bf681feb0` is the former byte-order bug and is a stop. For later cards,
copy the ID Studio shows onto that card's production record before continuing.

Do not trust a remembered `192.168.4.1` tab by itself. If Studio times out there
while the selected card is still reachable at `lightweaver.local`, stop and use
only Studio's same-card USB recovery. Reidentify the canonical card before any
erase or flash; never treat the stale setup address as proof that the card is
blank, absent, or ready.

## Build the card

- [ ] Studio says the selected USB device is the same ESP32-S3 card ID written
      above and the firmware release is signed and verified.
- [ ] Full erase and flash finish, USB release completes, and the card restarts.
      A disabled **Releasing USB…** button is still pending and does not pass.
- [ ] The external strip shows the factory beacon: exactly eight dim amber
      pixels, two pulses, then off. A green board LED alone does not pass.
- [ ] Studio shows **Blank — load a project** for this exact card. It does not
      show green, Connected, Ready, or Success.
- [ ] Join `Lightweaver-XXXX` when Studio asks and enter the gallery/home Wi-Fi.
      Stay on the card page until it says the card actually joined and shows a
      verified gallery-network address. Then return to the gallery Wi-Fi and
      the same Studio tab. Do not type or look up an IP address.
- [ ] The guided card page follows the same card from setup Wi-Fi to the LAN,
      retries automatically if its first LAN load happened too early, and Studio
      advances automatically only after two fresh status checks.
- [ ] Studio still shows the card ID written above. A different ID is a stop.
- [ ] Load the verified project once. Read-back shows all six facts:
      `GPIO 18` · `44 pixels` · `GRB` · `Aurora` · `1500 mA` · `0.35 limit`.

## See the real lights

- [ ] In every guided boundary check, the first included pixel is blue, the
      final pixel is red, the pixels between are dim, and everything outside is
      dark.
- [ ] Only the intended strip lights; the colors, direction, and endpoint are
      correct.
- [ ] The final Aurora check visibly lights and animates the entire 44-pixel
      strip—not eight pixels, a flicker, the browser preview, or the board LED.
- [ ] Studio independently reads the installed project back and records a
      fresh physical pass for this card ID.

## Prove recovery and hand off

- [ ] Power the finished card off and on. Aurora returns on the full strip
      without loading the project again.
- [ ] Studio temporarily stops showing green during restart, then becomes ready
      only after the same card returns and two new status checks complete.
- [ ] Turn the Wi-Fi network off. Studio demotes the card while the saved Aurora
      playback continues on the strip.
- [ ] Within 60 seconds, `Lightweaver-XXXX` reappears as the recovery hotspot.
- [ ] Restore the Wi-Fi network. The card reconnects automatically and Studio
      verifies the same card again without a typed address or project reload.
- [ ] Enter worker initials and export both the JSON and CSV production records
      into the batch folder. The record has this card ID and a final pass.
- [ ] Disconnect this finished card before connecting the next blank card.

## Stop rule

If any box fails, stop and do not ship the card. An HTTP response, green board
LED, eight-pixel beacon, partial light, brief flicker, or unexported on-screen
pass never replaces the missing check.

If Studio remains at **Releasing USB…**, `lightweaver.local` returns
`ERR_NAME_NOT_RESOLVED`, or the card appears on neither its prior LAN nor the
expected setup/recovery AP:

1. Record the failed stage, canonical card ID, and exact browser error.
   Do not check off USB release, restart, beacon, Wi-Fi handoff, or connection.
2. Let Studio's bounded operation finish or time out. Use its same-card retry if
   offered; do not repeatedly erase or flash while the write result is
   ambiguous.
3. If instructed, power-cycle and reinspect the one card over USB. It must again
   identify as the canonical ID written above before the run can resume.
4. Resume only when that exact card returns through USB, its expected AP, or a
   verified LAN status. A different Lightweaver, an unresolved hostname, or
   disappearance from both LAN and AP never counts as recovery.
5. If Studio offers no enabled retry/restart path, quarantine the card and file
   the run as a Production Setup failure. Do not use a terminal, typed address,
   or direct request to turn it into a production pass.
