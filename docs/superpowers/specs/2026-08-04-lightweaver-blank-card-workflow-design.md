# Lightweaver Card Re-entry Workflow Design

**Status:** Approved
**Date:** 2026-08-04

## Problem and outcome

The card currently sends every Studio return directly to Patterns. A factory card therefore lets Studio select a pattern and attempt live control even though no confirmed LED project exists, producing the **No project loaded** loop. The same direct route can also consume `editPattern` or `editLook` against an unrelated open Studio project.

Card re-entry must branch on exact paired-card evidence:

| State | Hardware behavior | Destination |
| --- | --- | --- |
| Factory blank | Pattern selection remains local; no bridge/window acquisition, `/api/control`, or `/api/config` | **Set up LED strips and install on card** → Layout/Wire |
| Configured Ready | Immediate acknowledged preview remains available once the exact installed project is open | Hardware overview/project resolver first, then Patterns |
| Non-factory recovery/unverified | Selection remains local; no hardware mutation | **Recover and verify card** → Card overview/recovery |

The first-project safety sequence remains Layout/Wire → Test & Install stages wiring → activate and inspect real LEDs → confirm matching activation → Ready. Lightweaver never guesses GPIO, LED count, direction, color order, or current limit.

## Authoritative state branch

Studio classifies the complete provisioning envelope from direct `/api/status` or the card bridge. It requires the exact paired `cardId`, supported contract, firmware/build/boot identity, and explicit readiness booleans.

- **Factory blank:** exact paired envelope, `runtimePhase: factory`, and `knownGoodProject: false`. Raw `mode: factory-flash`/`source: defaults` corroborate the state. Partial evidence is not factory evidence.
- **Ready:** `runtimePhase: ready`, `knownGoodProject: true`, `commandReady: true`, and `outputReady: true`.
- **Recovery/unverified:** any complete, exact paired, non-factory envelope that is not Ready. A load failure or pending candidate is never relabeled factory blank.
- **Checking:** incomplete, stale, unsupported, wrong-card, or boot-changed evidence. Checking cannot control hardware.

Only Ready may acquire the card page or send live control. Pattern selection always updates the current Studio preview first; blank, recovery, and checking stop before any hardware side effect. A late Ready response cannot replay a selection made while control was prohibited.

## Card-to-Studio routing and intent

The card exposes separate fixed-origin, station-targeted URLs:

- factory setup → `#screen=layout`;
- recovery → `#screen=card&section=overview`;
- Ready **Edit in Studio** → `#screen=card&section=overview` with `editPattern`/`editLook` preserved.

The overview resolves the installed project before consuming edit intent. After the exact project is already open or is explicitly loaded, Studio navigates to Patterns and consumes that intent once. Cancellation or failed resolution preserves both the open workspace and pending intent.

## Exact installed-project resolution

`/api/firmware-info` already reports `piece.id`, `projectRevision`, `projectFingerprint`, `productionJobId`, and `productionJobDigest`; Studio normalizers must preserve `piece.id`.

Match priority is:

1. current workspace: exact embedded project ID plus the existing deterministic card-project fingerprint;
2. production project: exact job ID, job digest, project revision, and project fingerprint;
3. active cloud project: exact `embeddedProjectId`, then fetch its document and compute the card-project fingerprint;
4. active browser record: exact `record.project.id` and computed card-project fingerprint.

The fingerprint is the existing FNV fingerprint of the commissioning restore snapshot. Cloud SHA-256 metadata is not interchangeable with it. Title, ID-only, partial tuple, stale revision, stale fingerprint, and archived-only records never match. Multiple exact matches require explicit selection.

Studio never replaces a project silently. The offer names the exact match and delegates loading to existing `replaceProject`/cloud open guards. Dirty work requires explicit discard confirmation; cancellation leaves autosave, active cloud attachment, and project contents unchanged.

## Errors and races

- Card ID, host, firmware build, boot ID, or project generation changes invalidate pending probes and previews.
- Blank/recovery taps do not queue a command for later delivery.
- Staged wiring never replaces known-good until physical confirmation; timeout, rejection, reboot, or abandonment rolls back.
- WiFi reconnect does not erase or reinstall a project. AP users still rejoin gallery WiFi before public Studio.
- Popup blocking, card probe failure, and route changes preserve the local pattern selection and dirty project.
- Untrusted card response text is never rendered.

## Tests

Coverage must prove dedicated blank setup and Ready/resolver URLs; preserved pattern intent; local-only Ocean selection for blank and recovery; zero popup/control/config side effects; immediate acknowledged Ocean for an already-open exact Ready project; recovery never entering blank install; exact project evidence and priority; title/partial false-match rejection; dirty-load cancellation; stale response suppression; and the unchanged staged activation/confirmation/rollback sequence.

Hardware acceptance uses factory-reset, confirmed Ready, and deliberately recoverable cards over station and AP re-entry.
