#!/usr/bin/env bash
# Prune the dead codex/* branches left over from the Codex era.
#
# Audited 2026-08-11: all 25 codex/* branches were compared commit-by-commit
# against main. Twenty are strict ancestors of main; commissioning-full-loop
# landed as ec3a1752 (#112/#113) and fix-wifi-schema-compat as b459873c (#111),
# both byte-identical; software-update-grant* carry only superseded artifacts
# plus one recovery fix that is now on main. Full findings: TODO.md, under
# "Branch consolidation audit".
#
# Deliberately KEPT:
#   archive/codex/connection-reliability-audit  reference for the outstanding
#                                              Phase 2 ports (see TODO.md)
#   claude/led-branches-merge-5k8lml            delete after its PR merges
#
# Usage:
#   ./scripts/prune-codex-branches.sh            # show what would be deleted
#   ./scripts/prune-codex-branches.sh --yes      # actually delete
set -euo pipefail

REMOTE="${REMOTE:-origin}"
KEEP="archive/codex/connection-reliability-audit"

BRANCHES=(
  codex/card-studio-handoff
  codex/color-layout-simplify
  codex/commissioning-full-loop
  codex/connection-reliability-audit
  codex/effortless-card-setup-overlay
  codex/effortless-lightweaver-flow
  codex/exhaustive-release-ui-fix
  codex/fast-development-loop
  codex/firmware-1-1-release-fix
  codex/fix-wifi-schema-compat
  codex/lightweaver-firmware-1-1-5
  codex/lightweaver-setup-journey-redesign
  codex/post-update-hardening
  codex/release-firmware-1-1-2
  codex/release-loop
  codex/release-loop-firmware-bump
  codex/reliable-chip-integration
  codex/software-update-grant
  codex/software-update-grant-main
  codex/studio-auto-reconnect
  codex/unified-setup
  codex/usb-update-commit-feedback
  codex/usb-update-feedback-release
  codex/windowless-offline-studio
  codex/windowless-offline-studio-release
  tmp/ccr-write-probe
  archive/codex/commissioning-full-loop
  archive/codex/fix-wifi-schema-compat
  archive/codex/software-update-grant
  archive/codex/software-update-grant-main
)

echo "Remote '$REMOTE' -> $(git remote get-url "$REMOTE")"
case "$(git remote get-url "$REMOTE")" in
  *technicianofthesacred/LED-Programming*|*technicianofthesacred/led-programming*) ;;
  *) echo "REFUSING: '$REMOTE' is not the LED-Programming repository." >&2; exit 1 ;;
esac

echo "Fetching…"
git fetch "$REMOTE" --prune --quiet

# The reference branch must survive; it is the only copy of 2462ca42's work.
if ! git rev-parse --verify --quiet "refs/remotes/$REMOTE/$KEEP" >/dev/null; then
  echo "REFUSING: keeper branch '$KEEP' is missing from $REMOTE." >&2
  echo "Its commit 2462ca42 would become unreachable. Investigate before pruning." >&2
  exit 1
fi
echo "Keeper present: $KEEP ($(git rev-parse --short "$REMOTE/$KEEP"))"

present=()
for b in "${BRANCHES[@]}"; do
  if git rev-parse --verify --quiet "refs/remotes/$REMOTE/$b" >/dev/null; then
    present+=("$b")
    printf '  delete %-48s %s\n' "$b" "$(git rev-parse --short "$REMOTE/$b")"
  else
    printf '  (gone) %s\n' "$b"
  fi
done

if [ ${#present[@]} -eq 0 ]; then
  echo "Nothing to do — already pruned."
  exit 0
fi

if [ "${1:-}" != "--yes" ]; then
  echo
  echo "${#present[@]} branch(es) would be deleted. Re-run with --yes to do it."
  exit 0
fi

echo
echo "Deleting ${#present[@]} branch(es)…"
git push "$REMOTE" --delete "${present[@]}"
git fetch "$REMOTE" --prune --quiet

echo
echo "Done. Remaining branches on $REMOTE:"
git branch -r | sed "s|^  $REMOTE/||" | grep -v HEAD | sort | sed 's/^/  /'
