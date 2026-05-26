# Lightweaver WLED Basic Export

The WLED Basic export creates a starter runtime package for an ESP32-S3 running WLED. It is for entry-level pieces that should run without a Pi, Mac, Madrix, or Lightweaver editor at runtime.

## What It Exports

The downloaded `wled-basic.json` package contains:

- `presetsJson`: WLED preset entries for stock-WLED-compatible Lightweaver looks.
- A playlist preset that cycles the generated preset bank.
- `controlContract`: the on-device physical-control contract for WLED, including encoder rotation/press behavior and the helper preset used for advancing Lightweaver looks.
- `customEffectPorts`: looks that can live on WLED only after being ported into a Lightweaver custom WLED build.
- `unsupportedPatterns`: looks from the current show that need Advanced Art-Net, live frame streaming, or standalone sequence export.
- `compatibilityAudit`: the full pattern-gate audit for the current Lightweaver library.
- Installer notes for applying the JSON API commands or uploading `presetsJson`.

## Current Basic Bank

The first Basic bank uses stock WLED approximations for:

- Candle
- Breathe
- Aurora
- Fire
- Rainbow
- Gradient
- Twinkle
- Sparkle
- Meteor
- Ocean
- Scanner
- Lava

These are intentionally practical approximations. Exact Lightweaver browser-rendered patterns still require a custom WLED effect port or the Advanced path.

## Install Path

1. Back up the controller's current WLED presets.
2. Export `wled-basic.json` from Lightweaver.
3. Run the controller compatibility audit and resolve any `needs-config` or `needs-install` findings.
4. Inspect `customEffectPorts` and `unsupportedPatterns`.
5. Apply the package with one of these methods:
   - Upload the generated `presetsJson` as WLED `/presets.json` from the WLED `/edit` page.
   - Or apply each preset state through `POST /json/state`, then save each preset with `psave`.
6. Load the generated playlist preset to cycle the Basic bank.
7. If the controller has a rotary encoder, bind the encoder press / WLED button action to the generated `LW Next Look` helper preset. Encoder rotation is handled on the ESP32 by a rotary encoder usermod or Lightweaver WLED firmware; the browser app does not need to be running for the knob to dim the piece.

The next installer step should automate backup and apply from inside Lightweaver once the user confirms the target WLED controller.

See `docs/pattern-compatibility-audit.md` for the current full-library gate list and `docs/controller-compatibility-audit.md` for the connected-controller findings.
