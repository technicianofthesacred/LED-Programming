# The waiting list for the next card update

## For Adrian — two commands

**What is waiting right now:**

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && npm run firmware:waiting
```

**Send everything that is waiting, as one pull request:**

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && npm run firmware:release
```

The second one gathers every waiting change, bumps the version, empties the
waiting list, and opens a single pull request for you to look at. It stops
there. Nothing is published and nothing reaches a card until you merge it.

If any waiting change no longer fits — because the project moved on since it
was written — it stops, tells you in plain English which one, and changes
nothing at all. A half-finished card update is worse than a blocked one.

## Why this exists

Sending a card update is deliberately expensive. It signs a binary and offers
it to every card sitting in a customer's home, so it is gated on a hand-made
version bump. That gate is right and is not going anywhere.

The side effect is that small, safe changes which the build system happens to
classify as "touches the cards" get put off, because paying a customer-facing
signed release for a convenience fix is a bad trade. Before this existed, those
deferrals lived in three places at once — a paragraph in `TODO.md`, a patch file
in a folder outside the repository, and a `git stash` entry that a single
`git stash clear` would have destroyed silently. Two of the three were outside
version control, and all three relied on someone remembering.

Now there is one register, in the repository, and one command to drain it.

## For agents — where things live and how to park work

- **The register** is `firmware-queue/queue.json`. Each entry says what the
  change is in plain language, why it was held back, when it was added, and
  where the actual change lives.
- **Parked patches** are committed at `firmware-queue/patches/*.patch`. Never a
  stash, never a path in someone's home directory.
- **Parked branches** are recorded by name and must exist on `origin`.
- **The tool** is `scripts/firmware-queue.mjs`.

Park a change:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && node scripts/firmware-queue.mjs add --branch <branch-name> --what "<one plain sentence>" --why "<one plain sentence>"
```

or, when there is no branch to point at:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && node scripts/firmware-queue.mjs add --id <short-name> --from-diff --what "<one plain sentence>" --why "<one plain sentence>"
```

`node scripts/ci-preflight.mjs` prints this add-command verbatim when it
refuses a firmware-sensitive change for want of a version bump. That refusal is
the exact moment work gets deferred, which is why the hook is there — parking
has to be cheaper than writing a paragraph nobody will find again.

Preflight also prints how many changes are waiting on **every** run, clean or
not, so the list cannot be quietly forgotten.

### Rules that keep it honest

- The register lives on `main`. Park a change on a branch that is **not**
  firmware-sensitive and open that as its own small pull request, so the parking
  itself never needs the release it is avoiding.
- `release` builds in a throwaway private worktree. The tree you run it from is
  never touched, and on any failure the worktree and the branch are removed.
- Branch entries are merged first, patch entries applied second — a merge needs
  a clean index, and parked patches are staged but not committed until the
  single release commit at the end.
- Redeeming deletes the patches it consumed and empties the register **in the
  same commit**, so nothing can be applied twice.
- The new version has to beat both the version in the tree and the version that
  is actually signed and published, or the signer refuses at the end of a
  twenty-minute job.

Rehearse without sending anything:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && node scripts/firmware-queue.mjs release --dry-run
```

Prove the whole mechanism, including the failure path:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led" && node --test scripts/firmware-queue.test.mjs
```

## Where the queue tooling is allowed to live

Everything here sits at the repository root — `scripts/`, `firmware-queue/`,
`docs/`, and the root `package.json`. That is not an accident.
`scripts/ci-changed-lanes.mjs` maps `lightweaver/package.json` to every lane
unconditionally, so putting these commands there would classify this very
change as touching the cards, and the queue would have to queue itself. Checked
against the classifier directly: the root `package.json`, `scripts/*`,
`firmware-queue/*` and `docs/*` all select the `source` lane only.
