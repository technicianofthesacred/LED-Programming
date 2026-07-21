# New Lightweaver card checklist

Run this once for every card in desktop Chrome or Edge at
`https://led.mandalacodes.com/#screen=production`. Use one card, one powered
44-pixel bench strip, and one USB data cable. Do not use a terminal, type a card
address, or recover outside the guided screen.

Write the card ID shown by Studio: `lw-________________`

## Build the card

- [ ] Studio says the selected USB device is the same ESP32-S3 card ID written
      above and the firmware release is signed and verified.
- [ ] Full erase and flash finish, USB is released, and the card restarts.
- [ ] The external strip shows the factory beacon: exactly eight dim amber
      pixels, two pulses, then off. A green board LED alone does not pass.
- [ ] Studio shows **Blank — load a project** for this exact card. It does not
      show green, Connected, Ready, or Success.
- [ ] Join `Lightweaver-XXXX` when Studio asks and enter the gallery/home Wi-Fi.
      Return to the same Studio tab. Do not type or look up an IP address.
- [ ] The guided card page follows the same card from setup Wi-Fi to the LAN,
      and Studio advances automatically only after two fresh status checks.
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
