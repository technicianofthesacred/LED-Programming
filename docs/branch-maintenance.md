# Branch and session maintenance plan

Adopted 2026-08-12. This is the standing policy for how work lands in this
repo (and the pattern for Adrian's other repos). It exists because many AI
sessions run in parallel — phone, desktop app, VS Code, other AI tools — and
no human can track which branches are mid-build. The policy makes the system
self-cleaning so Adrian stays in flow.

## The three-state rule

Every branch besides `main` must be in exactly one of three states:

1. **Has an open PR** — it is on its way to `main`.
2. **`archive/` prefix + a TODO.md entry** saying why it is kept and what
   event triggers its deletion.
3. **Deletable on sight** — anything that fits neither state above is
   presumed abandoned and may be pruned after an ahead/behind audit
   (see `scripts/prune-codex-branches.sh` for the audit pattern).

## Ownership check before opening a PR

A pushed branch is not proof the work is finished — the owning session may
still be building. Before opening a PR for a branch you did not author in
your own session:

1. List the account's sessions and find the one whose outcome branch matches.
2. If that session is **active or idle (not archived)**, message it and ask
   whether the branch is done. Do not open a non-draft PR without its answer.
3. If the session is **archived**, read its last status. "Complete" → open
   the PR. "Mid-way through X" → open a **draft** PR and flag the gap to
   Adrian.

Near-miss that created this rule: on 2026-08-12 a hygiene pass almost merged
`claude/led-system-issues-s96i9b` while its owning session was still
root-causing a follow-up. Drafts are the safety catch: a draft PR cannot
merge.

## Merge authority (Adrian's standing decision, 2026-08-12)

**Agents merge when green.** Once the owning session confirms the work is
done and CI passes, the agent merges the PR and deletes the branch without
asking. Adrian reviews outcomes, not buttons: the PR description in plain
language, then the real thing at the address he uses (per the 2026-07-26
"live" standard in THINKING.md). Do not batch merges; land one stream at a
time so a regression always implicates the last merge.

## Session-ending verb: "wrap it up"

When Adrian says **"wrap it up"** (or "land it") in any session, that means:
finish the current increment, then end the session with exactly one of —
**merged**, **PR opened and watched to green**, or **archived + logged in
TODO.md**. Never end a working session with only "pushed to branch X."
Sessions should apply this standard even unprompted when their work-stream
is complete.

## One tool per stream

Parallel streams are fine; two tools on one stream is how duplicate commits
happen. Land the branch before handing a stream to a different tool. Non-
Claude tools should use their own branch prefix (`codex/`, `hermes/`) so the
sweep can attribute branches.

## The daily sweep

A daily scheduled session ("Daily Tangle Sweep") surveys every reachable
repo: branches vs the three-state rule, open PRs and their CI, live sessions
and their outcome branches, staleness (>14 days without a PR = flag). It
takes the safe actions itself (draft PRs, session messages, prune-audit
lists) and asks Adrian only for genuine decisions — interactively, in its own
conversation, which he can reply into from his phone. The sweep is the
backstop: no habit of Adrian's is load-bearing, because anything missed today
is surfaced tomorrow.
