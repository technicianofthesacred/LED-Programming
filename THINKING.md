# Lightweaver — Thinking Log

Append-only log of direction / design / strategy conversations for Lightweaver
that produced rejected-with-reasoning calls or left open tensions worth
preserving across chats.

Future Claude: read these entries before re-proposing accounts, Stripe, cloud
catalogs, or other scaling infrastructure for Lightweaver. The rejections are
*reasoned*, not accidental.

---

## 2026-06-16 — Security hardening pass; three deliberate non-fixes

**Topic:** End-to-end security audit of the Lightweaver codebase (firmware,
Studio, Pi/Node server, mapper) followed by a full remediation pass in PR #8.
Fifteen findings, all addressed except three that require owner decisions or
are architectural rewrites.

**What shipped (commit 441650b):**
- C1: WiFi password stripped from `/api/firmware-info` (was readable by any
  device on the open AP in fallback mode)
- H1: `maxMilliamps` clamped at `LW_MAX_MILLIAMPS=20000` before FastLED
- H2: CORS allowlist tightened to exact origins; dropped the `*.mandalacodes.com`
  and `*.pages.dev` suffix wildcards
- M1: WebSocket (:81) handshake Origin validated
- M4: NVS size gate moved before parse/alloc
- C2: `new Function()` pattern eval hardened — globals shadowed as `undefined`
  params + compile-time denylist; covers AI drafts
- H3: CSP + X-Frame-Options added to `public/_headers`
- M3: `cardHost` URL param validated; bridge requires verified-local origin
  before privileged sends
- M5: `npm ci` in CI/go-live
- M6: dead unsanitized-SVG `dangerouslySetInnerHTML` path deleted
- H4 (Pi): `isAllowedWledHost` guards every `/api/wled/*` handler; WS Origin
  check; `wsPort` clamped to {80, 81}; RFC1918-only subnet scan
- M2 (Pi): rate-limit map bounded; startup warning when AI endpoint is
  unauthenticated beyond loopback
- Low: mapper innerHTML escaping; mapper pattern compiler global-shadowing

**Three deliberate non-fixes (reasoned, not missed):**

**1. Pattern execution is NOT sandboxed in a Web Worker (C2).** The
`new Function()` path keeps running synchronously in the page. The hardening
(global-shadowing + denylist + CSP `connect-src 'self'`) blocks the realistic
exfil vectors (token theft, outbound fetch). A true Worker sandbox was
evaluated and rejected because the per-pixel `evalPixel` API is synchronous —
moving to a Worker requires a full async rewrite of the preview engine and a
messaging protocol for frame-by-frame results. That's a multi-day architectural
change. Future Claude: do not re-propose the Worker sandbox without first
reworking the preview contract. The trigger for revisiting is either (a) a
report of actual exploit in the wild or (b) a decision to rewrite the pattern
preview pipeline anyway for another reason.

**2. AI endpoint auth remains default-open (M2).** `hasValidAuthToken` returns
`true` when `AI_PATTERN_AUTH_TOKEN` is unset. The fix adds a startup warning
but does not flip the default. Forcing it to default-required would break the
documented local single-user flow (Adrian runs the Pi server locally; there's
no deploy-time secret management) and would break all existing tests. The
correct unlock is: set the env var when/if the Pi server is ever exposed beyond
localhost (e.g., a public-facing Pi). Future Claude: don't re-flip the
default without knowing how the server is deployed.

**3. Firmware postMessage bridge still trusts `*.lightweaver-edw.pages.dev`
(H2 follow-up).** The HTTP CORS allowlist (H2) was tightened to exact origins,
but `lwBridgeAllowed` in `LightweaverWeb.cpp` — the card-side postMessage
receiver — still uses a regex matching any `lightweaver-edw.pages.dev`
subdomain. This was deliberately left to stay surgical (separate trust surface,
different code path, its own test coverage). It means any Pages preview branch
can send postMessage commands to a connected card. Low real-world risk today
because the attacker would need to (a) push a Pages branch on the
`lightweaver-edw` project and (b) socially engineer the owner to open it while
on the card's WiFi. Future Claude: the fix is to replace the subdomain regex in
`lwBridgeAllowed` with the same exact-origin list used by `corsOriginAllowed`.

**Open tensions:**
- The "trust model is whoever is on the WiFi" is a deliberate product decision
  for a gallery art piece, not an oversight. Authentication on the firmware HTTP
  API would require session tokens or a PIN, which breaks the captive-portal
  zero-friction UX. That tradeoff stands.
- The audit could not probe live deployed endpoints (`led.mandalacodes.com` or
  real cards) — all findings are from source. Production header values (H3 CSP)
  and C1/H2 card behavior should be confirmed on hardware.

**Full report:** `docs/security-audit-2026-06-16.md`
**Follow-up TODOs:** "Security hardening" block in `TODO.md` (under ## Soon)

---

## 2026-05-28 — Defer accounts, Stripe, and cloud catalog while sales are one-on-one

**Topic:** Mid-session, after shipping zones + drift palette + push-to-card + a
designer bundle at /design, the conversation turned to "what unlocks the launch."
Adrian asked about owner accounts ("they sign up like Amazon"), and what would
help close in-person sales. The pull was strong toward building auth + a
customer DB + a cloud pattern catalog. The question was whether that's the
right next investment.

**Convergent answer:** Build for the actual sale shape, which is one-on-one
in-person handoffs with cash/Venmo. The right work right now is anything that
helps a customer take a piece home and *love it after the first night*: a
printable handoff card, a support page at led.mandalacodes.com, an on-card
recovery story for when they lose WiFi. Accounts, Stripe, and cloud catalogs
are scaling infrastructure for "the website is the sale" and "I push patterns
to customers I've never met." Adrian has neither problem today. The deeper
realization: building auth + catalog now is the technically interesting work,
but it's the wrong work — it costs days and unlocks nothing until there's
both a checkout flow AND ≥5 customers asking for new patterns. Until then,
manual push from the designer (already shipped, push-to-card with host input)
plus a paper card handed to the buyer plus a support URL is enough.

**Rejected paths, with reasons:**

- **Build Tier 1 accounts (Clerk signup, profile page, order history) now.** Rejected because Adrian has no checkout flow yet; an account that does nothing transactional is a sign-up flow customers will skip and a maintenance burden Claude will add to without value returning.
- **Build the cloud catalog (Sprint 3) — server-side pattern publishing with per-customer targeting.** Rejected because (a) requires card-identity + claim protocol + check-in protocol — multiple days of architectural lift, (b) unlocks nothing until there are enough pieces in customers' homes that you actually want to push to them without being on their WiFi. Threshold is ~5 pieces shipped + customers asking for new patterns.
- **Wire Stripe to led.mandalacodes.com as a "buy a piece" path.** Rejected as premature — the page doesn't have hero photography of an actual piece, doesn't have a price, doesn't have a real product description. Stripe is the last 10%, not the first 10%.
- **Build pattern authoring as a tier-3 "customers create their own patterns" feature.** Rejected because the homeowner market wants new patterns *delivered to them*, not authored. The designer at /design is the artist's tool, not the customer's. Customer pattern authoring is a totally different product (an art platform) and conflating the two muddies both.
- **Add Tier 2 (cards bound to accounts) at the same time as Tier 1.** Rejected because card-claim protocols, card-side check-in, secure phone-home are all real engineering. Tier 1 alone (account + profile + order history) is ~1 day if Clerk is wired; Tier 2 adds ~2-3 days on top of that.

**The honest tensions left unresolved:**

- Adrian likes the *idea* of accounts ("owners becoming registered for many reasons"), so deferring them is a judgment call about timing, not a permanent no. The trigger for revisiting was named: ≥5 pieces sold or a website-driven sale request.
- The "Why sign up?" copy on the landing currently says "you don't need an account to use your piece" — which is honest now but flips meaning when accounts ship. Future copy work will have to revise this section without making it feel like a bait-and-switch.
- The designer at /design and the customer surface at / share infrastructure (same mandalacodes Pages project, same hostname split via led.*) but serve completely different audiences. Long-term, the designer probably needs auth (so other artists can't push to your customers' cards) before the catalog ships. That's connected work.
- Codex landed Madrix/Art-Net + WLED-realtime frame sources in parallel during this session. Capable but invisible until pushed to. Worth surfacing in a future demo when the in-person flow can show "and Madrix users can stream into this too" as a power-user pitch — but that's not a homeowner pitch.

**Concrete next moves, in order:**

1. ~~Ship 9-pattern grid, drift palette, push-to-card, designer bundled at /design, support content on the landing, printable handoff card draft.~~ Done this session.
2. **Print 25 handoff cards** at a local print shop or VistaPrint from led/docs/handoff-card.md. Then use them for the next 25 sales.
3. **Do the next in-person handoff** with the card. Watch the customer's face during steps 2-3 (join AP, captive portal). The friction you see is the next thing to fix.
4. **Take a real photo of a Lightweaver piece running** (strip lit, wood-and-LEDs surface visible, in a room) and replace the placeholder Lightweaver wordmark on led.mandalacodes.com with hero photography. This is what turns the landing from "support page" into "I want one." No code change, just an asset and a copy pass.
5. **Defer everything else** — accounts, Stripe, cloud catalog, multi-card UI, schedules — until either ≥5 pieces are sold OR a customer asks for a feature whose absence is blocking a sale.

**What this entry exists to prevent:** Future Claude reading this file: don't re-propose accounts, Stripe checkout, or a cloud pattern catalog for Lightweaver without first checking whether the in-person sales shape has changed. If Adrian still hands pieces to people he meets, the answer to "let's add auth" is still no. The unlock is a website-driven sale or ≥5 pieces in the wild, not a feeling that "we should have accounts by now."

---
