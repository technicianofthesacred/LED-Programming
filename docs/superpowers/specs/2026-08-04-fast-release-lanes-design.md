# Fast release lanes

## Goal

Make ordinary Lightweaver iteration reach production in minutes without allowing an unbuilt revision, an unsigned firmware release, or an unverified live graph to count as shipped.

## Decision

The blocking path uses focused lanes selected from the changed paths. The exhaustive browser suite remains available as `launch:source` / `launch:check`, but moves off the normal production critical path and runs asynchronously on a schedule and on demand.

One workflow owns source validation. Pull requests and main pushes must not start duplicate copies for the same revision. A required aggregate gate accepts only the selected focused lanes. UI lanes run in parallel; firmware-sensitive changes additionally run firmware contracts and then the protected signer. Generated signer-only artifacts run release-integrity checks, not the full Studio browser suite.

Deployment accepts an exact 40-character revision. UI-only revisions deploy after the focused source gate. Firmware-sensitive revisions wait for the protected signer and deploy only the signer commit. The deploy still builds, stages, verifies, migrates, uploads, and proves the exact no-store production graph.

## Blocking lanes

- Source/build: Node contracts relevant to the changed surface plus Vite build, Pages staging, and staged-graph verification.
- Browser smoke: Show, screen recovery, and a focused workflow smoke set.
- Cloud/production: only when cloud functions, migrations, production setup, or their tests change.
- Firmware-sensitive: production jobs, installer/runtime contracts, PlatformIO identity compile, and protected signing.
- Signed artifact: manifest signature, provenance, binary identity/freshness, and generated production-job consistency.

The complete 303-screen release suite runs non-blocking after merge, nightly, and manually. Its failure is visible and must be repaired, but it does not make every interactive UI iteration wait nineteen minutes.

## Safety boundaries

- Main requires the aggregate fast gate and must be up to date before merge.
- Direct pushes to main are disabled except for the protected signer token path.
- The signer checks out the tested revision explicitly and refuses stale release inputs.
- Deploy refuses a revision that is not the current remote main.
- Production credentials, D1 migration checks, build/stage verification, and strict live proof remain mandatory.

## Target timings

- UI pull request feedback: 2–5 minutes.
- UI main-to-live: 3–6 minutes.
- Firmware-sensitive main-to-live: 7–10 minutes.

