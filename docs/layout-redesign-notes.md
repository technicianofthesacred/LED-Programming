# Layout Redesign — What We Found and What Changed

**Dates:** 2026-07-10 → 2026-07-11 · **Written for:** Adrian, to read back later, no code knowledge needed.
**Companion doc:** `layout-redesign-plan.md` in this folder is the engineer-facing version (the full technical plan with every step). This file is the plain-language record.

---

## Why we did this

The Layout screen had grown into one wall of ~40 controls. Five polish commits in a row had been patching symptoms without touching the cause. When we mapped every feature, the diagnosis was simple:

**The screen was doing three different jobs at once, in one panel:**

1. **Drawing** — turning your artwork into LED strips. Creative work, done when the art changes.
2. **Sizing** — making the numbers match the physical piece (how big, how dense, how many LEDs). Arithmetic, done once per piece.
3. **Wiring** — matching the on-screen order to how the strips are actually soldered. Bench work, done once, then never touched.

Because all three shared one panel: dragging meant three different things depending on where you grabbed, there were four different ways to "group" things, the same setting (density) appeared in two places, and — the worst one — **the wiring order was stored in two places that could silently disagree**, meaning what the list showed you wasn't guaranteed to be what got sent to the card.

And the punchline: **the two most important buttons — "Send to card" and "Export for WLED" — existed fully working in the code with no button to press them.** The screen had no finish line.

## What it became

One canvas, three modes — **Draw | Size | Wire** — switched at the top of the toolbar (or keys 1/2/3):

- **Draw** — artwork layers, make-strips actions, and a strip inspector (name, direction via the compass — click its center to switch between glow-all-around and directed light — color, brightness).
- **Size** — one top-to-bottom chain that mirrors how the math actually works: artwork size → LED density → each strip's count. If you hand-set a strip's count it gets a "manual" badge and **stays put** when everything else rescales (before, it was silently wiped). "Calibrate from this strip" is honest about what it does: it uses that strip's real count as ground truth and rescales the whole piece.
- **Wire** — the strip list *is* the wiring order now (drag a row = rewire), with the split/gap/link tools, ending with **Send to card** (with a live connection light) and **Export** for WLED-compatible software.

Every control has exactly one home. The reversible "Group" and the destructive "Combine into one strip" are now clearly different buttons.

## Discoveries along the way (the surprises)

1. **Three versions of the wiring order existed in the code** — what the list showed, what the export used, and what the card-push math used. They could all disagree. Now there is exactly one, and the migration was designed so that **every project you've already saved keeps its exact LED addressing** — proven by a test, not hoped.
2. **The old address math had a real bug**: it ignored "gap" segments (intentionally dark LEDs) when computing positions, so a design with a gap could light the wrong LEDs relative to what the preview showed. Fixed as part of the unification.
3. **Undo was lying to you.** Wiring edits (splits, links) and density changes were never undoable at all, and the screen secretly kept two separate undo systems. Now there's one, everything is undoable, and undo even restores what you had selected.
4. **The automated tests had silently rotted.** 20 of 23 browser tests were checking a frozen old version of the interface — they couldn't catch anything. They were rebuilt first, then guarded every one of the ~20 changes that followed.
5. **Every screen overflowed on phones** — and the culprit wasn't the suspected element. The app was reserving a fixed 320-pixel column that nothing used, taxing every screen at phone width. Fixed for the whole app, checked on all seven screens.
6. **Freehand drawing had a crash bug** introduced during the work and caught by a later agent double-checking — drawing a strip with two or more points would have thrown an error. Fixed, and it's the reminder of why every step got re-verified.
7. **A real Lightweaver card appeared on your WiFi mid-build** and its security check — correctly — rejected the development environment, which broke two tests. The tests are now sealed against outside network conditions.

## What deliberately did NOT change

- **The trust model** (anyone on the WiFi can control the piece) — that's the gallery-piece product decision from the security review, untouched.
- **Your saved projects** — they open identically, addressing byte-for-byte the same.
- The Patterns / Playlist / Show / Flash screens — the redesign stayed inside Layout (a separate session worked on Show's audio in parallel).

## What's left (your part)

1. **The hands-on pass** — import a real artwork file, walk Draw → Size → Wire, push to a bench card. 36 automated checks are green, but they can't judge *feel*. That's the one thing only you can do.
2. **Merge decision** — everything sits on this workspace's branch, unmerged. Option: push it and have Codex do a remote second-opinion review first.

## Where everything lives

- **This file** — the plain-language record (you are here).
- **`layout-redesign-plan.md`** (same folder) — the full technical plan: diagnosis, every design decision with its reasoning, all 24 steps, risk register.
- **The branch history** — each of the ~20 commits carries a plain explanation of what it did and what proved it safe.
- **`TODO.md`** (project root) — the hands-on pass is the top item.
