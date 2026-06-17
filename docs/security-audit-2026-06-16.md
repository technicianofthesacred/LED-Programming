# Lightweaver — Security Audit (2026-06-16)

Read-only application-security audit of the Lightweaver codebase, followed by a
remediation pass. This document is the record of what was found, what was fixed
in commit `441650b` (branch `claude/sharp-allen-7atzz2`), and what remains for
owner decision.

> **Scope note.** The audit was originally requested against a "Teajia tea
> inventory system" at `teajia-api.lightcodes.workers.dev/mcp`. That system is
> **not in this repository** (this is the LED / Lightweaver project), and its
> live endpoint is blocked by the environment's network egress allowlist. Per
> follow-up direction the audit was retargeted to the actual Lightweaver code.
> There is **no relational database** here, so SQL-injection / foreign-key /
> tea-data-unit categories do not apply.

## Trust model and surfaces

| Surface | Code | Deployed today? | Exposure |
|---|---|---|---|
| ESP32-S3 firmware | `firmware/lightweaver-controller/` | **Yes — the product** | Open WiFi AP, HTTP :80, WS :81, Art-Net UDP :6454, WLED-realtime UDP :21324 |
| Studio (React) | `lightweaver/src/` → `led.mandalacodes.com` | **Yes — public internet** (Cloudflare Pages) | Public HTTPS static site + postMessage card bridge |
| Pi / Node server | `lightweaver/server/`, `led-art-mapper/pi-server/` | **No — deferred / local-only** | LAN Express + WS proxy; also the AI-pattern backend |

**Auth model:** effectively *"anyone within WiFi range is trusted."* The
firmware has no authentication on any endpoint; the Studio is public with no
auth; the Pi API has no auth/CORS. The real controls present are the card-side
postMessage origin allowlist and the (default-off) AI auth token. There is no
OTA endpoint, so a card cannot be reflashed over the network.

**Data stores (no SQL):** ESP32 NVS flash (`RuntimeConfig`, incl. WiFi creds),
browser `localStorage` (projects, custom JS pattern `code`, `lw_ai_pattern_token`),
and JSON files (`ledmap.json`, `config.json`, `.lightweaver-ai.local` provider
keys at mode `0600`, `.lightweaver-usb.json`).

## Findings and remediation

Severity reflects impact on the **live** runtime. Pi-server findings are real
but currently un-deployed.

### Critical

- **C1 — WiFi password disclosed over the open AP.** `/api/firmware-info`
  serialized `wifi.password` (`main.cpp`). In AP-fallback mode anyone in range
  could read the homeowner's SSID + plaintext password.
  **Fixed:** response now emits only `wifi.configured` (boolean); password is
  never serialized. NVS storage of the credential is unchanged.

- **C2 — Unsandboxed `new Function()` pattern execution on the public origin.**
  "Live patterns" (and AI-returned `draft.code`) compiled with `new Function`
  ran with full `window`/`fetch`/`localStorage` access, able to exfiltrate the
  AI token or drive the card bridge.
  **Fixed (defense-in-depth, synchronous API preserved):** the shared
  `compile()` in `lightweaver/src/lib/patterns.js` shadows dangerous globals as
  `undefined` parameters (`window`, `self`, `globalThis`, `document`, `fetch`,
  `XMLHttpRequest`, `WebSocket`, `localStorage`, …) and applies a compile-time
  identifier denylist (`import`, `constructor`, `__proto__`, `prototype`,
  dynamic `import(`, `async`/`await`). AI drafts inherit the fix via the same
  `compile()`. CSP `connect-src 'self'` (H3) is the network backstop.
  *A true sandbox (Web Worker / wasm interpreter) remains a future option — see
  follow-ups.*

### High

- **H1 — Unclamped `maxMilliamps` (physical safety).** Passed straight to the
  FastLED power limiter; a huge value defeats the brownout limiter.
  **Fixed:** clamped to `LW_MAX_MILLIAMPS` (20 A / 100 W at 5 V) in
  `LightweaverStorage.cpp`.

- **H2 — Destructive endpoints + broad CORS.** `corsOriginAllowed` matched any
  `*.mandalacodes.com` and any `*.lightweaver-edw.pages.dev` preview subdomain;
  with PNA enabled, a rogue preview deploy or XSS could factory-reset/wipe the
  card from a victim's browser.
  **Fixed:** exact-origin allowlist only (`https://led.mandalacodes.com`, the
  one referenced preview host, localhost dev origins).

- **H3 — Missing CSP / framing headers.** `public/_headers` had no CSP/XFO.
  **Fixed:** added `Content-Security-Policy` (`default-src 'self'`,
  `connect-src 'self'`, `frame-ancestors 'self' https://led.mandalacodes.com`,
  `object-src 'none'`, `base-uri 'none'`; keeps `'unsafe-eval'` for
  `new Function`) and `X-Frame-Options: SAMEORIGIN`.

- **H4 — SSRF in the Pi WLED proxy (deferred runtime).** `/api/wled/*` and the
  WS proxy forwarded to an arbitrary `?ip=` host:port:path with no Origin check;
  `?scan=1` swept whole /24s.
  **Fixed:** `isAllowedWledHost` (RFC1918 / loopback / `.local` / captive IPs
  only; link-local incl. the cloud-metadata IP blocked) on every handler; WS
  upgrade Origin validated; `wsPort` clamped to {80, 81}; subnet scan limited to
  RFC1918 ranges.

### Medium

- **M1 — Port-81 WebSocket accepted any Origin.** **Fixed:** handshake Origin
  validated against the shared allowlist (`LightweaverWledWebSocket.cpp`).
- **M2 — AI endpoint abuse surface (deferred runtime).** Auth default-off and an
  unbounded per-IP rate-limit map. **Partially fixed:** map is now bounded
  (evicts expired entries) and the server warns at startup when no
  `AI_PATTERN_AUTH_TOKEN` is set while bound beyond loopback. **Default-open is
  intentionally retained** (see *Owner decisions*).
- **M3 — Card-bridge handshake optimism.** Trusted `cardHost` from URL params
  before a verified `ready`. **Fixed:** `cardHost` validated as a local host
  (`isLocalCardHost`); privileged sends (`config`/`control`/`reboot`/
  `recover-lights`) require a resolved-local target origin; verified-ready flag
  added.
- **M4 — Config size gate ran after parse/alloc.** **Fixed:** size check moved
  to the top of `saveRuntimeConfigJson`.
- **M5 — `npm install` (not `npm ci`) in CI/go-live.** **Fixed:** `npm ci` in
  `deploy-site.yml` and `scripts/go-live.sh`.
- **M6 — Dead unsanitized-SVG `dangerouslySetInnerHTML` path.** Unreferenced
  `LayoutScreen`/`ExportScreen` in `OtherScreens.jsx`. **Fixed:** dead
  components and their now-unused helpers deleted (`FlashScreen` retained).

### Low / informational

- **Fixed:** LAN-discovered device names HTML-escaped before `innerHTML` in the
  mapper (`led-art-mapper/controller/src/main.js`, `pi-server/src/main.js`);
  mapper pattern compilers given the same global-shadowing hardening as C2.
- **Noted (not changed):** firmware numeric masking (`& 0xff`) instead of range
  rejection; `ensure-rollup-native.mjs` unpinned install (platform-derived, not
  injectable); committed sample `led-art-mapper/pi-server/data/config.json`.

### Protections confirmed present (do not regress)

Art-Net / WLED-realtime / WLED-JSON / WS pixel writes are consistently
bounds-checked against `totalPixels` / `LW_MAX_PIXELS` (no buffer overflow
found); card-side bridge enforces an origin allowlist; live SVG path uses
`escapeAttr`; AI keys stored at `0600` and never echoed; no secrets in source or
git history (only test placeholders); CI has no `pull_request_target` / untrusted
`${{ github.event.* }}` shell injection; HTTPS→bridge mixed-content split is
correct by design.

## Verification

On the combined tree: firmware node tests, `lightweaver` `test:unit`, and
`launch:check` (`test:core` ≈ 35 suites + production build) all pass.

## Owner decisions (deliberately not auto-applied)

1. **AI auth default-open (M2).** Forcing `AI_PATTERN_AUTH_TOKEN` to be required
   would break the documented local single-user flow and existing tests. Set the
   token if the Pi/AI server is ever exposed beyond localhost.
2. **C2 hardening vs. true sandbox.** A Web Worker / wasm-interpreter sandbox
   would break the synchronous per-pixel preview contract; the shadowing +
   denylist + CSP combo was chosen instead. Revisit if stronger isolation is
   wanted.
3. **postMessage bridge preview-subdomain trust.** The firmware's
   `lwBridgeAllowed` still trusts `*.lightweaver-edw.pages.dev` (a separate
   surface from the H2 HTTP-CORS fix). Tighten if preview-subdomain trust should
   be dropped there too.

## Could not inspect

- **Live deployed endpoints** — egress allowlist blocks outbound to the
  originally-named host, and live cards / `led.mandalacodes.com` were not probed.
  All findings are from source; confirm production header values (H3) and live
  card behavior (C1/H2) against the deployed targets.
- **The "Teajia" system itself** — not in this repo/scope and unreachable.
