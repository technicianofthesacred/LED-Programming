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

## 2026-07-26 — "Live" means at the address Adrian uses; OTA deliberately deferred

**Topic:** During the wiring/sizing UI redesign sessions (PRs #32–#35 and the
strips-first follow-ons), repeated confusion about whether shipped work was
visible: merged-to-main ≠ deployed ≠ what Adrian's phone showed (mobile Chrome
cache), and Adrian set a standard: **a thing is "live" only when it fully works
at the address he uses.** Anything else must be named precisely: "deployed to
the web app" (led.mandalacodes.com serves it) or "published, needs a flash"
(signed firmware on the site awaiting a USB flash).

**Architecture facts pinned while resolving this (verified in source):**
- The card serves ONLY the C++-embedded visitor scene-selector and advanced
  setup pages. Every Studio screen (Wire/Size/Draw, commissioning) runs from
  led.mandalacodes.com in a browser and reaches the card through the bridge
  tab. "The card's wiring UI" does not exist — it always was the website.
- There is NO OTA path. Cards never poll for updates and cannot be updated
  over the LAN. The only firmware path: CI compiles/signs/publishes the
  factory bin on merge to main, then a human flashes over USB Web Serial from
  the Studio flash screen.

**Rejected for now: building card OTA without an explicit owner decision.**
The signing/manifest/verification infrastructure already exists and would
support it, but a gallery wall piece that updates itself mid-show — or bricks
on a failed write — is a product decision, not a technical one. USB bench
flashing stands until Adrian explicitly opts in. The unlock trigger: Adrian
asks for it, or ≥ several pieces live in customers' homes where bench
reflashing stops scaling (which intersects the 2026-05-28 cloud-catalog
thresholds — read that entry too before proposing).

**Also learned, cheap to fix later:** mobile Chrome has no hard refresh
(clear site data is the only reliable path), which twice made Adrian believe
deployed work wasn't deployed. The build-stamp TODO exists so version
questions become observable instead of argued.

---

## 2026-08-05 — Build numbers replace commit hashes; two things that look like bugs but aren't

**Topic:** Adrian: "The number where it says studio current is unrelatable. How
about you actually have a number and I can compare each build each push." The
Studio footer showed `Studio current fe1948d0aea2`. Answering "am I on the
latest?" from a phone meant comparing two opaque hashes — the concrete cost
named in the 2026-07-26 entry. Both Studio and firmware now publish a
first-parent Git depth build number (411 → 412 → 413, one per merge to main).

**Two deliberate choices that a future reader will mistake for defects:**

**1. `buildNumber` is optional when READING a firmware manifest, required when
BUILDING one.** `MANIFEST_KEYS` does not contain it; `OPTIONAL_MANIFEST_KEYS`
does. This is not laziness. The signing key lives only in the protected CI
secret, so the manifest committed at the time of this change could not be
re-signed locally. Making the field required would have made the already-signed
release fail validation the moment the change merged — and the signer only runs
*after* a green Tests gate, so Tests would have gone red and blocked the very
job that fixes it. Deadlock. The builder emits it unconditionally and
`assertFirmwareManifestBuildNumber` refuses to produce a manifest without one,
so every release from here forward has it. Future Claude: the TODO item
"Require `buildNumber` in the firmware manifest" is the unlock — do it only
after confirming the live signed manifest actually carries the field.

**2. The Studio number and the firmware number can differ by one. That is
correct.** On a firmware-sensitive merge, the signer compiles the binary from
revision N, then commits the signed artifacts *on top* of N and deploys the
site from N+1. Both numbers honestly describe the source each artifact was
built from. Do not "fix" this by forcing them equal — that would mean one of
them lying about its provenance. The comparison that actually matters to the
owner is card-number vs signed-manifest-number, and those two are built in the
same job from the same revision, so they always agree exactly.

**Rejected: deriving the number from a date (`2026.08.05-1`).** Readable, but
it breaks determinism — the release marker has to be byte-identical across
rebuilds of the same revision or the live freshness proof (which SHA-256s the
marker against the deployed build graph) fails. First-parent depth is a pure
function of the revision. Commit-count without `--first-parent` was also
rejected: merging a 10-commit PR would jump the number by 11 instead of 1.

**Also pinned:** CI checkouts that build or test a numbered artifact now use
`fetch-depth: 0`. A shallow clone makes `git rev-list --count` return 1, which
would have silently published "build 1" — a wrong number is worse than no
number, because it reads as authoritative.

---

## 2026-08-07 — The URL is the only place the current screen lives

**Topic:** The Studio navigation race that broke twice in one day and was
patched twice. The second patch (in `694f250`) added a one-shot "claim" ref so
the hash-sync effect could tell a real in-app navigation from a screen that had
already moved the URL. Adrian's read — "I patched it but don't fully trust it"
— was correct, and the diagnosis found two holes in it before any code moved.

**Root cause, which is not timing.** `view` (React state) and
`window.location.hash` were two stores of one fact, reconciled by an effect.
Three kinds of code moved them: `navigateStudio`/`openCardSection` moved state
and let the effect move the URL; twenty-odd screens navigate by assigning
`window.location.hash` directly, which moves the URL immediately but delivers
`hashchange` a task later; and three `setView` calls in the bridge-callback
path moved state and wrote no URL at all. Between a direct hash assignment and
its `hashchange`, the state is stale — and an effect reconciling from stale
state stamps the old screen back over the destination. That is how the card's
"continue to Patterns" handoff died.

**Why the claim ref was not the fix:**

1. *It leaked.* `navigateStudio` armed the ref and then called `setView(next)`.
   Navigating to the screen you are already on is a React bail-out, so the
   effect never ran and never consumed the claim. It stayed armed, and an armed
   stale claim authorizes exactly the overwrite it was added to prevent.
2. *It made three navigations silently lie.* The guard's other half —
   "canonicalize only a hash that still names the screen we are on" — means any
   `setView` that is not a claimed navigation now leaves the URL naming a
   different screen. A Bridge result accepted in another tab does exactly that:
   Layout renders under `#screen=card&section=setup`, and a reload, a bookmark
   or the recovery support code all read the wrong screen. This was reproduced
   in a browser before the fix and is now `tests/studio-route.spec.ts`.

**What shipped instead.** `view` and `cardRoute` are derived from the hash via
`useSyncExternalStore`; the hash is the only store. `src/lib/studioRoute.js`
holds the route vocabulary and the canonicalization as pure functions of a hash
string, so reconciliation is idempotent. There is one reconciler effect and it
reads the *live* URL for both the route and the screen — never the rendered
`view`, which is a snapshot of the route as it was when that render began. The
first attempt at the refactor passed `view` in and reintroduced the same class
of bug one layer down; the new test caught it. Net −51 lines in `app.jsx`.

**Deliberately not done: converting the twenty-odd `window.location.hash = …`
call sites to a navigate() helper.** Under the derived model they are already
correct — they move the single source of truth, and the screen follows. Routing
them through a helper would be tidier to read but would change no behaviour, so
it stays a cleanup, not a fix. Future Claude: if you do it, it is a rename, not
a race fix, and it must not reintroduce a second store of the current screen.

**Open tension:** `history.replaceState` fires no `hashchange`, so the route
store dispatches its own event. Anything that writes the hash *without* going
through the store or a direct assignment (there is nothing today) would move
the URL invisibly. The store is the place to enforce that if it ever comes up.

---

## 2026-08-07 — The handoff loop: a guard is only as durable as the thing that holds it

**Topic:** Verifying the routing fix above turned up a second defect on the same
journey — the one that actually looked like "the pattern link is broken" to an
owner. It was not a hang. The card→Patterns handoff was a ping-pong running at
~45 resolutions per second, six HTTP requests each, aimed at the ESP32 on the
customer's shelf, while the screen sat on a disabled "Verifying project…".

**Root cause, in two halves.** The card screen issued the pattern authorization
with the installed project id read from `/api/firmware-info` (which carries
`piece.id`); the Patterns screen re-derived that binding from the card-link
readiness envelope, which is `/api/status`. Those are different payloads.
Firmware only began sending `projectId` on `/api/status` in `f1ad74e`
(2026-08-04) and has never sent `piece.id` there — so against any card flashed
before that build, the card issued an authorization Patterns could not claim,
every time, forever. That is the spark.

The amplifier is what made it a flood. Patterns returns the owner to the card
when it cannot claim, and the card auto-opens Patterns for as long as it can
read an intent in the URL. Every hop unmounts and remounts both screens, and
both screens' "only do this once" guards are component-scoped `useRef`s —
`cardProjectProbeRef` on the card, `cardReturnConsumed` on Patterns. A remount
resets them, so the guards defended nothing across exactly the transition that
needed guarding.

**Two things that look like the fix and are not.**

*Stripping the intent from the URL on a failed claim.* This was written and
then withdrawn: `patterns-v3.spec.ts` asserts the intent survives an
unauthorized landing, and it is right to. `?editPattern=ocean` is still what
the owner came for, and an explicit "Load this project" should honour it. The
breaker belongs on the automatic hand-over, not on the owner's request — so a
failed claim is now remembered at module scope in `src/lib/cardEditIntent.js`,
where a remount cannot forget it, and the card offers the project instead of
opening it.

*Fixing the fixture.* `readyStatus()` in `card-workspace.spec.ts` omitted
`projectId`, which is why `…auto-opens only with preserved edit intent` drove
the loop on every run and then passed or failed on whether its URL poll
happened to sample `#screen=pattern` mid-flip — a coin toss gating Deploy site
and the signed firmware release. Correcting the fixture alone would have turned
the gate green and left the loop shipping. It was corrected last, deliberately.

**Deliberately not done: making `cardProjectProbeRef` module-scoped.** It is
the other half of the amplifier and the change is two lines, but the guard's
signature includes the project generation and the card boot id, and a
module-scoped copy would outlive a genuine remount-to-retry that some other
screen depends on. The intent breaker already makes the loop unreachable.
Future Claude: if you do lift it, the question to answer first is which
legitimate flows expect a remount to re-probe.

**Left open:** the same omission is in most card-status fixtures across the
suite — `card-link-state.mjs` (~39 sites), `cardReadiness.test.js` (~31),
`playlist-storage`, `connection-center-quality`, `screen-smoke`. They model a
ready card that reports no installed project, which no real card does. Harmless
until someone writes an authorization test against one. Logged in `TODO.md`.

---

## 2026-08-19 — The card that could never match: legacy fingerprints, and the Access wall around the update grant

**Topic:** Adrian's real gallery card (lw-b0fe81f61b44, firmware build 1306)
was "inaccessible": Setup phase 1 offered "Use this card's project" which
appeared to do nothing however many times it was pressed, and "Start secure
Wi-Fi update" died at a bare "Failed to fetch". Both were reproduced against
the physical card on the LAN and root-caused. Two different defects, one
session.

**Bug 1 — adoption worked, recognition was impossible.** The card reports
`projectRevision: 0` and an EMPTY `projectFingerprint` for the project it
genuinely holds — it was installed before fingerprint reporting existed.
Clicking "Use this card's project" adopted the project correctly (verified in
localStorage: same id, same 41-pixel strip on pin 18), but every recognition
path — `resolveCardProject` (regex-rejects empty fp as 'invalid'),
`markInstalled` (`exactIdentity` required a well-formed fp, so `verified:
false`), `installationMatch`, `deriveCardLifecycle.exactProject` — demanded a
well-formed fingerprint equality. So Setup stayed on phase 1 with the same
buttons and the identity row said "differs from open project" about a project
with an identical id. The button looked dead because success was invisible.

**The fix is a structural stand-in, not a relaxation.** An empty card
fingerprint verifies ONLY through the `studioFingerprint` the adoption
recorded — the structural hash of the project rebuilt from the card's own
readback — plus exact card id, revision, and project id agreement
(`markInstalled`, `reverifyInstallation`, `installationMatch`,
`legacyFingerprintBinding` in `deriveCardLifecycle`). A card that reports a
real fingerprint must still match it exactly; an empty fingerprint with no
recorded stand-in still binds nothing. Future Claude: do not "simplify" this
into accepting id-equality alone, and do not require fingerprints universally
again — either direction re-strands one class of card. The legacy state heals
permanently the first time a project is saved to the card (the new install
writes a real fingerprint).

**Bug 2 — the update grant lives behind Cloudflare Access, and the error was
a lie.** `/api/library/*` on led.mandalacodes.com is deliberately behind
Cloudflare Access until the native-account cutover
(docs/deployment-checklist.md runbook; LIGHTWEAVER_NATIVE_AUTH_READY is still
unset — verified live: /api/library/session 302s to
soft-band-fe5b.cloudflareaccess.com). PR #122 later put
`/api/library/firmware-update-grant` INSIDE that wall. A browser without an
Access session gets a cross-origin login redirect on the grant POST, which
fetch reports as bare "Failed to fetch" — a dead end. The card side was
healthy the whole time (challenge endpoint + CORS + private-network preflight
all verified against the real card).

**What shipped:** the grant client detects the redirect (`redirect: 'manual'`)
and names the owner sign-in; the update panel probes `/api/library/session`
before offering software authorization and defaults to the physical
card-button path (which needs no server at all — firmware requires a recent
physical BOOT press via `runtimeOwnerPairingAuthorized`) with "Open owner
sign-in" and "Check again" affordances.

**Not done, deliberately:** the native-auth cutover itself (owner bootstrap,
password ceremony, removing the Access rule) is Adrian's runbook, not a code
fix — and until it runs, ALL /api/library features (cloud project library,
accounts) still require an Access session in the browser. The grant was NOT
moved outside the wall: it must stay owner-authenticated, and pre-cutover the
Access wall IS the owner authentication.
