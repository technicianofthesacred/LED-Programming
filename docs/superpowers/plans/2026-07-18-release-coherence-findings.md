# Release-coherence pass — evidence audit and strengthened plan (2026-07-18)

Four independent read-only reviews (workflow/IA, persistence/migration/recovery,
card/firmware/bridge/browser, release/tests/safety) were run against `main`
@ `8f2c0ae` with the app running in a real browser. This document reconciles
their findings with the source and the Phase 1A/1B plan, records what changed
in the plan, and answers the open product questions. Implementation ownership
for the pass is listed at the end.

## Plan corrections (what the audit changed)

1. **Preview defect re-scoped 2 → 17.** The firmware customer page
   (`handleRoot`) is missing 17 of 30 factory pattern swatch styles —
   `ripple, lava, meteor, chase, candle, lightning, neon, matrix, heartbeat,
   stained, confetti, warp, pulse-ring, blocks, bloom, calm, drift` — not just
   Ripple and Lava Lamp (`LightweaverWeb.cpp` ~295–310 vs the full advanced-page
   block ~765–796; factory list `LightweaverStorage.cpp` ~1002–1015). The
   regression test must cross-check the factory id list against both embedded
   pages, not assert helper regexes.
2. **Pattern selection: customer page is sound; the advanced page is the
   defect.** The customer page uses an acknowledged control with optimistic
   rollback, a pending lock, an explained streaming lock with Cancel stream,
   Retry on failure, and never reorders the grid (verified in source and by the
   existing rollback contract tests). The reported "selection fails" could not
   be reproduced there. The **advanced page** grid, however, is purely
   optimistic — no rollback on 422/network failure and no streaming lock, so a
   tap during an active stream returns 200 with no visible change. That is the
   plausible mechanism behind the report and is the part to fix, with coverage.
   A second plausible mechanism: with 17 gray tiles, a successful selection
   between two gray tiles *looks* like nothing happened.
3. **Two new confirmed persistence defects.**
   (a) *Forward-version autosave destruction:* an autosave with an unknown
   (newer) project version fails migration, the default project loads, and the
   500 ms autosave overwrites both the primary and backup copies — the user's
   newer-format project is gone within ~1.5 s (realistic after a Studio
   rollback). Unrecognized payloads must be quarantined, never overwritten.
   (b) *False-dirty at boot:* the startup restore always bumps the edited
   revision, so a fresh or freshly-restored app shows "Unsaved changes" and
   arms the discard dialog on an untouched project; "Saved in browser" never
   survives reload. The fix must keep protecting autosave-restored-but-never-
   library-saved work from silent New/Load discard.
4. **The signed-firmware gate is GREEN, not red.** CI commit `582a476`
   rebuilt/signed the merged firmware source; `factory-bin-freshness` passes at
   `8f2c0ae`. The "Current release limiter (2026-07-16)" paragraph in
   `docs/deployment-checklist.md` was stale (now rewritten): the remaining
   limiter is **physical acceptance**, not artifact staleness.
5. **Gate health.** CI runs only 3 of 26 Playwright suites and 5 of 38 lib
   unit files; one test on clean `main` was already red
   (`screen-smoke.spec.ts` settings-alias row, stale after `#screen=settings`
   became a Preferences alias). The pass fixes the stale test and widens the
   launch gate with the suites that cover the changed surfaces.
6. **Bridge/handoff correction is smaller than planned.** The native-Bridge
   launch navigates the current tab (no popup), and the card bridge already
   reuses one named window with a visible popup-blocked reason. The actual
   defects: several UI call sites open the card page with unnamed `_blank`
   targets (minting extra tabs and racing the tracked bridge window), and the
   secure-installer escape anchors mint a new unnamed tab each click. The
   secure-installer escape itself is **required** by browser security when
   Studio is embedded/insecure (Web Serial needs a top-level secure context)
   and must be preserved with its reason made visible.
7. **New reproduced UX defects added to scope:** the Card overview/Recovery
   "Reconnect card" primary is a silent no-op when the probe fails (the guided
   Connection Center is only reachable from the footer); the Patterns screen
   horizontally overflows at 390 px and the Playlist preview status is clipped
   off-screen on phones; the Playlist zero-looks empty state reads "All mixes
   added."; the rail lacks `aria-current`; rail vs card-section navigation
   disagree on history push/replace.
8. **Label system decided** (see Q5 below): one verb — **Save to card** — for
   the acknowledged config/project write everywhere; **Install or update**
   reserved for firmware; **Save project** = browser library; **Export
   project** = `.lw.json` file download; **Import project** = file load;
   Layout toolbar Save/Load relabeled Export/Import with the same canonical
   naming; "Looks" is the product noun (not "mixes").

## Finding table

| # | Finding | Evidence | Class | Sev | Required change | Owner | Acceptance test | Phase |
|---|---|---|---|---|---|---|---|---|
| 1 | 17/30 factory patterns gray on customer page | `LightweaverWeb.cpp:295–310` vs `LightweaverStorage.cpp:1002–1015`; advanced block 765–796 complete | Confirmed defect | High | Add 17 `.sw-*` rules to `handleRoot`; shared-coverage regression test | FW agent | Test derives factory ids from `LightweaverStorage.cpp` and fails if either page lacks any `.sw-<id>` | 1A |
| 2 | Advanced-page selection: optimistic, no rollback, no streaming lock | `LightweaverWeb.cpp:879` (`renderGrid`), `main.cpp:380–391` | Confirmed defect | Med | Acknowledged rollback + streaming lock/explanation on advanced grid | FW agent | Source test asserts rollback + lock on advanced page | 1A |
| 3 | Customer-page/Studio selection contract | `makeConfirmedControl` :519/575; `cardAction.js`; `visitor-control-rollback.mjs` | Already solved / report **unreproduced** | — | Retain implementation; keep coverage | — | existing suites | 1A |
| 4 | 422-after-partial-slider-apply (TOCTOU) | `LightweaverWeb.cpp:1404–1411` | Confirmed defect | Low | Deferred (documented) — card-side subtlety; Studio still rolls back | — | — | deferred |
| 5 | Recovery screen: no support code/diagnostics | `app.jsx:94–158`; `console.error` only | Confirmed defect | Med | Sanitized failure record persisted across reload; bounded `LW-UI-xxx` code, route, error name; Retry + Open Layout kept | Persist agent + shell | screen-recovery spec asserts code/route after failed recovery; no project data in output | 1A |
| 6 | Forward-version autosave destroyed | reproduced: `{version:99}` seed overwritten in ~1.5 s (`ProjectContext.jsx:749–763, 843–858`) | Confirmed defect | High | Quarantine unrecognized autosave before first flush; surface status | Persist agent | fixture: forward-version autosave survives reload in quarantine key | 1A/1B |
| 7 | False-dirty at boot; persisted label lost on reload | reproduced; `ProjectContext.jsx:750–763` | Confirmed defect | Med | Suppress startup-restore edit bump without losing restore-guard | Persist agent | fresh boot shows non-dirty; save→reload keeps persisted state; restored-unsaved project still guarded | 1B |
| 8 | Card settings duplicates Layout/Wire editors; no Edit in Layout | `lw-settings.jsx:651–760`; browser-verified | Confirmed defect | Major | Read-only summary + **Edit in Layout** deep link; delete mutators from card mode | Fable | no card-workspace input mutates strips/outputs; deep link lands `#screen=layout&mode=wire` | 1B |
| 9 | Workshop presented as normal Card journey | `lw-card.jsx:16, 168`; browser-verified | Confirmed defect | Major | Remove from section bar/overview; separate **Batch production** entry (Advanced & Support tile + overview footer link); preserve all routes | Routing agent | nav has no workshop tab; `#screen=production`, `job` links, `#screen=card&section=workshop` still open it | 1B |
| 10 | Card-write verb chaos (4 names; "Install"/"Load" collisions) | `lw-pattern.jsx:1172`, `CardPushControl.jsx:162`, `lw-playlist.jsx:606`, `lw-card.jsx:45,102` | Confirmed defect | Major | One verb "Save to card"; firmware keeps "Install or update"; ladder relabel | Fable | label audit test/spec expectations | 1B |
| 11 | Save/Load/Download collisions; 3 export formats | `app.jsx:534`, `lw-settings.jsx:441,668`, `useLayoutImport.js:104–138` | Confirmed defect | Major | Canonical `.lw.json`; consolidated project area; legacy imports kept; Layout Save marks persisted + clears record id | Persist agent + Fable | import matrix (.lw.json/.lwproj.json/.json/v1/v2/v3) passes; one export path | 1B |
| 12 | Overview/Recovery "Reconnect card" silent no-op | reproduced in browser | Reproduced UX | Major | Connect actions open Connection Center | Fable (prop) + Routing agent (use) | clicking connect visibly opens guided flow | 1B |
| 13 | `_blank` card-page opens bypass named bridge window; installer anchors mint tabs | `lw-playlist.jsx:417,490`, `lw-settings.jsx:597`, `lw-pattern.jsx:1115`, `lw-flash.jsx:376`, `CardConnectionCenter.jsx:236` | Reproduced UX | Low | Named-window card-page opener helper; named installer target; keep secure fallback + visible reason | Bridge agent + Fable call sites | tests: popup-blocked, reuse-one-tab, fallback reason visible | 1B |
| 14 | Patterns overflows at 390 px; playlist status clipped | reproduced (scrollWidth 555) | Confirmed defect | Major (phone) | CSS fixes `.pm-*`, `.pl-hostrow` | Fable | no horizontal scroll at 390 px on any route | 1B |
| 15 | Playlist zero-looks empty state false | `lw-playlist.jsx:760` | Confirmed defect | Minor | distinct empty-state string | Fable | spec asserts | 1B |
| 16 | Rail lacks `aria-current`; history push/replace inconsistent | `app.jsx:212, 372 vs 404` | Confirmed defect / Reproduced UX | Minor | add `aria-current`; one history policy | Fable | spec asserts | 1B |
| 17 | Stale red test on main (settings alias) | `screen-smoke.spec.ts:507` vs `app.jsx:380` | Confirmed defect | High (process) | Update test to Preferences alias reality | Fable | screen-smoke green | 1B |
| 18 | Launch gate runs 3/26 UI suites, 5/38 unit files | `.github/workflows/test.yml`, `package.json` | Confirmed gap | High (process) | Add `test:unit` + key UI suites to launch gate | Fable | `launch:source` includes them | 1C |
| 19 | Deployment-checklist limiter paragraph stale | `factory-bin-freshness` passes at `8f2c0ae` | Already solved / stale doc | Med | Rewrite limiter: physical acceptance remains | Fable (docs) | — | 1C |
| 20 | Looks vs mixes naming | `lw-pattern.jsx:1168` etc. | Confirmed defect (naming) | Minor | "Looks" wins in visible copy | Fable | spec strings | 1B |
| 21 | Streaming lock unexplained on card page | banner exists with Cancel (`LightweaverWeb.cpp:404–408`) | Already solved | — | none | — | existing | — |
| 22 | Install/write acknowledgement, wrong-card, restart guards | `cardCommissioningFlow.js`, `cardIdentity.js`, `cardLink.js` | Already solved | — | preserve | all | existing suites | — |
| 23 | `lwBridgeAllowed` pages.dev wildcard | THINKING.md 2026-06-16 §3 | Product decision (deliberate non-fix) | Low | unchanged | — | — | deferred |
| 24 | Silent default-project fallback when both autosave copies unreadable | `ProjectContext.jsx:762` | Product decision | Low | status line in project area (covered by quarantine work) | Persist agent | fixture asserts notice | 1B |
| 25 | 641 px footer overflow in screen-smoke | webfont-blocked env suspect | Needs reproduction | Low | re-run with fonts before treating as bug | — | — | deferred |

## Answers to the open questions

1. **Does the workflow omit a required step?** Two were implicit and are now
   explicit: *WiFi setup* (inside Connect/Install commissioning, not a
   destination) and *physical verification* (the commissioning "Test lights"
   stage plus the Wire bench check). The workflow strip must show Connect →
   Layout → Looks → Playlist → Save to card / verify → Save/export.
2. **Should firmware installation always appear?** No. It appears when the
   connected card needs it (blank card, `firmware-too-old`,
   `identity-missing`) — already encoded in the overview presentation — and as
   a non-forced "Check for update" action when a healthy card is connected.
3. **Where does WiFi setup belong?** Inside the card connect/commissioning
   flow (install → join `Lightweaver-XXXX` → continue), surfaced by the
   Connection Center; never a separate product destination.
4. **Where does physical bench verification live?** In the commissioning
   "Test lights" stage and Layout/Wire's bench-test gate before install;
   the deployment checklist remains the authoritative physical gate.
5. **Save-vocabulary:** autosave = automatic *recovery copy* (never the user's
   intentional save; labeled as such with its timestamp); **Save project** =
   editable browser-library record; **Export project** = portable `.lw.json`
   file; **Save look** = reusable visual configuration in the project;
   **Save playlist** = playlist state in the project; **Save to card** = the
   acknowledged install of configuration onto the connected card; **production
   pass record** = manufacturing evidence, not a project save.
6. **Storage unavailable/corrupt?** Corrupt primary restores from backup
   (existing); both-unreadable or forward-version payloads are quarantined and
   surfaced in the project area instead of being silently overwritten; save
   failures show "save failed"; the recovery boundary refuses auto-reload when
   the safety copy cannot be written (existing `saveBlocked`).
7. **Card disconnects mid-write?** Existing contract preserved: bridge
   keepalive → "Card restarting…" → honest disconnect after 15 s; partial
   POSTs rejected by firmware; wiring writes staged as candidates with
   card-issued activation ids; Studio never claims success without the exact
   revision acknowledgement.
8. **Streaming prevents selection?** Customer page: grid locked with a visible
   banner naming the source and a Cancel-stream action (existing). Advanced
   page: gains the same lock/explanation (currently silently no-ops). Studio:
   selection queues the newest intent and cancels its own stream.
9. **Wrong card reconnects?** Existing triple guard preserved: pre-mutation
   identity verification, ack-time cardId comparison, discovery-time
   rejection with explicit "Use this card instead" adoption.
10. **Legacy project hardware fields disagree with Layout?** Deterministic
    rules already exist and are tested: saved wiring outputs are physical
    truth; stale `dataWireCount` cannot add/remove/repin outputs and sets
    `dataWireCountNeedsReview`; legacy patch-board mismatches emit warnings,
    un-verify runs, and refuse to lock. Preserved unchanged; Card additionally
    stops offering a second editor for these fields (finding 8).
11. **Can the installer reuse the card/Bridge tab everywhere?** No — and it
    must not. Web Serial requires a top-level secure (HTTPS) context, so an
    embedded or HTTP context must escape to the public installer URL; that
    escape stays. What converges: the escape target gets a stable window name,
    UI card-page opens reuse the one named bridge window, and the fallback
    reason is shown. On HTTPS Studio commanding an HTTP card, one auxiliary
    card-page context remains technically required (mixed-content rule).
12. **Routes/extensions/projects at risk?** All preserved and tested:
    `#screen=production` (+`job=`), `#screen=card&section=workshop`,
    `#screen=flash&mode=install`, `#screen=settings`, `#screen=installer`,
    secure-installer URL, imports of `.lw.json`/`.lwproj.json`/plain `.json`
    and project versions 1/2/3, `lw_autosave_v1`/`lw-layout-autosave` legacy
    keys, library envelope both forms, commissioning registry, production run
    slots and pass records.
13. **Is Batch production still discoverable?** Yes: direct URL (printed
    QR/job links), a labeled tile in Advanced & Support, and a low-emphasis
    "Batch production" line on the Card overview — none presented as a setup
    step.
14. **First-time user completes one artwork without Advanced/Batch?** Yes on
    the happy path today, with three stalls this pass removes: silent connect
    no-op, install-verb confusion, and three competing save/export meanings.
15. **Actions showing success before acknowledgement?** None found in the
    normal path (Studio and customer page both gate on acks). The technician
    manual flash tool reports esptool completion — acceptable, technician
    surface. The advanced-page grid was the one violator (finding 2, fixed).
16. **Error messages actionable without sensitive state?** Recovery gains
    code/route/error-name only — no project contents, hosts, or tokens;
    diagnostics exports already redact (production). Autosave quarantine
    reports status, not payload.
17. **Mobile/keyboard/reduced-motion/screen-reader?** Playlist reorder and
    card section nav are solid (verified); gaps fixed: rail `aria-current`,
    Patterns 390 px overflow, clipped playlist status. Reduced-motion behavior
    unchanged. Full audit beyond these is future work.
18. **What still requires Adrian + hardware?** Everything in
    `docs/deployment-checklist.md` §0/§6 and the wiring/production acceptance
    lists, plus the outstanding 2026-06-11 WiFi-recovery and 2026-06-16
    security bench checks, plus visual confirmation of the 30 pattern
    previews and the advanced-page selection fix on a real card. This pass
    stops at that documented physical gate.

## Deliberately NOT done in this pass

- No Worker sandbox, no AI-auth flip, no bridge-wildcard change (THINKING.md
  deliberate non-fixes stand).
- No multi-card, templates, power dashboards, Pi hosting, cloud control, OTA.
- No pattern-engine changes for the thumbnail fix.
- No customer-page or Studio selection rewrite (report unreproduced there).
- TOCTOU partial-slider apply (finding 4) and the 641 px footer question
  (finding 25) are documented, not fixed.
