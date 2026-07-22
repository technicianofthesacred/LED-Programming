# Lightweaver card provisioning — remaining work

Updated on 2026-07-22 after reproducing the setup-AP-to-gallery-LAN browser
handoff failure on the real ESP32-S3. The provisioning flow is still not
shipment-ready.

## Current truth

- The physical card's esptool/USB MAC is `44:1B:F6:81:FE:B0`. Its canonical
  firmware/LAN identity is `lw-b0fe81f61b44`.
- The former USB ingress result, `lw-441bf681feb0`, was a byte-order bug. The
  browser Web Serial and native bridge mappings were fixed and regression
  tested, the protected signed release containing the fix was deployed, and
  live Studio verified `lw-b0fe81f61b44` for the real USB card.
- That exact identity result proves only card selection and identity. It does
  not prove USB release, application boot, network reachability, configuration,
  command readiness, or physical output.
- Serial evidence showed the post-release run briefly booted the app and then
  re-entered `DOWNLOAD(USB/UART0)`. The ESP32-S3 RTC-watchdog restart fix
  returned the real card with a new boot ID at its station address in about
  nine seconds. It reported `knownGoodProject/configValid: false` and
  `commandReady: false`, so Studio must call it blank rather than connected.
- No factory beacon, boundary frame, full-strip Aurora, continued playback, or
  other physical-light result was visually verified during diagnostic recovery.
- The protected signer published build `df20968`, the strict live verifier
  proved all 51 deployed files, and live Studio flashed that signed image to the
  exact USB card with confirmed USB release. After the erase, the old station
  route disappeared and the card-page tab targeted `192.168.4.1`; the setup-AP
  join and every later physical gate remain open.
- The same card subsequently proved a successful gallery join at
  `192.168.18.70`: exact card/build, final `station` transition, AP inactive,
  and truthful factory/blank state. Studio was stuck because its one LAN-tab
  navigation happened while the workstation was still on the setup AP and was
  never retried after returning to gallery Wi-Fi. Production could also accept
  AP-host `handoff-ready` metadata as final station evidence. Focused topology
  regressions now cover both failures; publishing and live re-run remain open.

## 1. Post-flash dead end — deployed, USB transition verified

- [x] Reproduce the live sequence with the same explicit evidence boundaries:
      exact USB identity succeeds, the release/reset transition starts, and no
      later step is credited unless the operation actually completes.
- [x] Give post-release exact-card discovery a bounded timeout and an error
      state. The controls
      must become usable again and explain whether release, reset, or
      post-reset inspection failed.
- [x] Preserve `lw-b0fe81f61b44` as the immutable expected identity across the
      error. A retry, reload, delayed callback, or second tab must not replace it
      with `lw-441bf681feb0` or another reachable card.
- [x] Provide a same-card recovery action that can retry release/reset and, when
      needed, guide a power cycle plus USB reinspection without blindly erasing
      or reflashing an ambiguous result.
- [x] Treat `ERR_NAME_NOT_RESOLVED`, failure at the prior LAN address, and an
      absent AP as three failed routes—not as evidence of a successful boot,
      handoff, or AP shutdown. Surface the route evidence to the worker.
- [x] Resume the existing run only after the exact card returns through USB,
      the expected AP, or complete verified LAN status. Otherwise quarantine
      the card/run and leave every later gate incomplete.

## 2. Recovery contracts — automated gates complete

- [x] Add focused regression coverage for a stuck USB-release promise, release
      timeout, reset failure, and successful same-card retry.
- [x] Cover unavailable card-page routes. Assert that the
      UI does not advance, does not show green, does not enable mutations, and
      offers an actionable recovery path.
- [x] Cover recovery after power cycle/reinspection with
      `44:1B:F6:81:FE:B0` returning as `lw-b0fe81f61b44`; reject the old
      byte-order ID and every different card.
- [x] Re-run the complete source, Production Setup browser, native bridge, and
      firmware contract gates without weakening the two-envelope/lifecycle
      readiness requirements.

## 3. Publish the recovery release

- [x] Merge only after the complete source gate is green.
- [x] Require the protected signer to publish a fresh signed factory release
      for any firmware changes; do not bypass `factory-bin-freshness`.
- [x] Confirm the credentialed Cloudflare Pages deploy actually ran. A green
      workflow that reports **Production publish: NOT RUN** is not deployment.
- [x] Run the required live production check and verify the root build graph,
      every JS/CSS asset, signed firmware, provenance, and indexed job all match
      the deployed checkout.

## 4. Re-run the live erased-card acceptance

Use `https://led.mandalacodes.com/#screen=production` and follow
[`new-card-checklist.md`](new-card-checklist.md). No terminal, typed IP, direct
HTTP command, board LED, or eight-pixel beacon can substitute for this run.

- [x] Fully erase and flash the blank ESP32-S3 through the live Studio.
- [x] Confirm USB MAC `44:1B:F6:81:FE:B0` is retained as canonical card ID
      `lw-b0fe81f61b44`, then confirm USB release/reset actually completes.
- [ ] Observe exactly the bounded eight-pixel/two-pulse amber factory beacon.
- [ ] Confirm Studio says **Blank — load a project**, never green.
- [ ] Complete the guided hotspot-to-LAN handoff in the same Studio flow; the
      exact card must return automatically and supply two fresh statuses.
- [ ] Load exactly one GPIO 18 / 44 / GRB / Aurora / 1500 mA project and verify
      the independent read-back.
- [ ] Complete every guided boundary check and visually confirm the entire
      44-pixel strip lights and animates correctly.
- [ ] Save/export the pass record for `lw-b0fe81f61b44`.
- [ ] Power-cycle: the full saved Aurora look must return, and Studio must
      demote then revalidate the new boot before showing ready.
- [ ] Turn Wi-Fi off: playback must continue, Studio must demote, and the
      recovery AP must appear within 60 seconds. Restore Wi-Fi and confirm
      automatic same-card recovery without reloading the project.

Only after every box above passes is this card, or the repeatable production
flow, ready to ship.

## 5. Follow-up outside the blank-card production path

- [ ] Make Wi-Fi changes on an already commissioned card transactional: retain
      the last working credentials until the proposed network is verified, and
      roll back after a failed change. Today the recovery AP and re-entry flow
      remain available, but a wrong proposed password replaces the stored prior
      network before association succeeds. Blank factory cards have no prior
      network, so this does not replace or block the live erased-card gate above.
