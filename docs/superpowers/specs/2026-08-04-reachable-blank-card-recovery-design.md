# Reachable blank-card recovery

## Goal

A reachable factory-default Lightweaver card must immediately offer project creation/install even when a stale WiFi handoff leaves firmware reporting `runtimePhase: recovering`.

## Evidence and root cause

The live card answered at `192.168.18.70` with a stable identity and valid provisioning contract, but with `mode: factory-flash`, `source: defaults`, no project identity, zero outputs, and `knownGoodProject: false`. Its WiFi state was `handoff-abandoned` and `transitionPending: true`, which changed the runtime phase to `recovering`. Studio currently treats blank only when the phase is `factory`; it therefore returns `runtime-not-ready`, never enables the blank workflow, and never reaches project resolution.

## Decision

Factory-default evidence is authoritative for blank-card classification after identity and contract validation. A card with `mode: factory-flash` or `source: defaults`, no installed project identity, and no known-good project is `blank` even if WiFi recovery changes the runtime phase. Blank does not mean command-ready: pattern commands remain blocked until a project is installed and verified.

Studio also adopts a safe local `cardHost` URL hint immediately for discovery. Private IPv4 and `.local` hosts remain the only accepted values. The IP is tried before mDNS so an intermittent `.local` resolver cannot hold the screen at “Checking card.”

## User flow

- Reachable factory-default card: show “Blank card — create or install a project” and actions to use the current Studio project or start a new one.
- Reachable nonblank card with exact current project: authorize and open the requested pattern.
- Reachable nonblank card with another recoverable project: save the current workspace, resolve the exact browser/cloud/production project, then switch.
- Unreachable or wrong card: show an actionable connection state; never claim blank and never send commands.

Autosave-before-switch, exact card/project fingerprints, one-use edit authorization, and post-install verification remain unchanged.

