# Preserving Lightweaver firmware updates

## Status

Approved direction from Adrian on 2026-08-10:

- Routine firmware updates preserve Wi-Fi credentials, the complete editable
  project, patterns, wiring, and all card settings.
- A connected card updates over its existing local Wi-Fi connection.
- Cards that predate the network updater receive one USB bootstrap update that
  also preserves all data.
- Factory erase remains an explicit deep-recovery action, never the routine
  update path.

This design supersedes the current assumption that every firmware update uses
the signed merged factory image. It does not weaken the existing exact-card,
publisher-signature, physical-confirmation, Stop, or recovery requirements.

## Problem

The production installer currently publishes and installs one merged factory
image at address `0x0` with erase-all enabled. That is correct for a blank card
or deliberate factory recovery, but it erases Wi-Fi credentials, project data,
wiring, patterns, and settings. The owner must then change networks, re-enter a
password, reconnect the browser, and reconstruct or restore the card after
every firmware update.

That loop is unnecessary. The ESP32-S3 `default_16MB.csv` layout already has two
6.25 MiB application slots (`app0` at `0x10000`, `app1` at `0x650000`) and
separate data partitions. The installed Arduino/ESP-IDF framework has
bootloader application rollback enabled. The current application is far below
one slot's capacity. Routine updates can therefore replace only an application
slot while leaving every data partition untouched.

The currently deployed firmware does not expose an OTA endpoint, and the
signed release manifest contains only a merged factory image. Both firmware
delivery and release artifacts must change together.

## Product outcome

An owner with a connected, update-capable card sees one bounded flow:

`Preparing → Updating → Restarting → Reconnected`

The card stays on its saved Wi-Fi, retains the exact same Card ID and project
head, and returns automatically after one reboot. The owner never selects an
SSID, re-enters a password, changes networks, reselects the card, chooses a
binary, enters a flash address, or decides whether to erase.

An older card receives one explicitly labeled USB bootstrap:

`Checking card → Preserving data → Updating firmware → Restarting → Reconnected`

The USB bootstrap replaces only the application in `app0`. It does not erase
or rewrite NVS, OTA selection data, `app1`, the project filesystem, or any other
data partition. Once bootstrapped, the card supports the normal Wi-Fi A/B path.

Factory reset remains available under recovery with an explicit statement that
it erases Wi-Fi, project, wiring, patterns, and settings.

## Chosen architecture

### 1. Two signed release artifacts

The protected signer publishes both artifacts for the same firmware identity:

1. **Factory image** — the existing merged image for blank-card installation
   and deep recovery.
2. **Update image** — the application-only PlatformIO `firmware.bin` for A/B
   OTA and the bounded USB bootstrap.

The signer also publishes a canonical `firmware-update-ticket.json` and a
detached P-256 signature over its exact bytes. The ticket has a strict,
fixed-key schema:

- schema version;
- firmware semantic version, Git build number, and build ID;
- target `esp32-s3-n16r8`;
- application image URL, byte size, and SHA-256;
- required partition-layout identity and application-slot capacity;
- supported firmware API and project-schema ranges;
- minimum updater/bootstrap compatibility;
- an explicit declaration that the update image contains no data partitions.

The existing signed firmware manifest references the ticket, signature, and
update image by URL, size, and SHA-256. The public Studio verifies the release
chain before offering an update. The card independently verifies the update
ticket signature with the pinned production public key before accepting the
image. Browser verification alone is never publisher authorization.

The canonical ticket is signed as exact bytes so the ESP32 does not need to
reimplement a general JSON canonicalization algorithm.

### 2. Card-side network updater

The firmware exposes a narrow local update API alongside the existing
exact-card owner-capability boundary:

- preflight validates the signed ticket, exact card/boot/session/generation,
  installed identity, partition layout, slot capacity, project-schema
  compatibility, storage health, and absence of another mutation;
- begin acquires an update lease, cancels live frame streams through the
  canonical Stop path, places output in a safe acknowledged state, and opens
  only the inactive application slot;
- chunk accepts bounded binary chunks with exact monotonic offset/sequence and
  a total-size ceiling from the signed ticket;
- commit finalizes the image, verifies the full SHA-256 and application image
  structure, marks the inactive slot pending, and schedules one reboot;
- status reports the update phase, received bytes, expected identity, active
  and pending slots, last error, rollback result, and reboot correlation.

Every mutation requires the existing owner capability plus a fresh physical
confirmation on the exact card. The update lease is bound to Card ID, Boot ID,
owner session, operation generation, expected project head, release build ID,
and update ticket digest. A changed binding aborts the inactive write and leaves
the running slot and all card data unchanged.

Chunks are local-LAN traffic from Studio to the card. The card never polls the
cloud and never updates itself unattended.

### 3. A/B boot probation and rollback

After commit, the card boots the new inactive slot in pending-verification
state. The new firmware must complete card-local health checks before marking
itself valid:

- compiled identity matches the signed ticket;
- NVS and project storage mount without destructive repair;
- saved configuration parses within the supported schema;
- the existing project head and fingerprint are readable;
- renderer, output policy, controls, card API, watchdog, and recovery controls
  initialize successfully;
- no unsafe resource or migration condition is present.

Internet reachability, router availability, mDNS, and the browser remaining
open are not boot-health requirements. A healthy card must remain valid while
offline.

If the firmware crashes, reboots, fails a health check, or does not confirm
within the probation deadline, the rollback-enabled bootloader returns to the
previous application slot. The previous slot reads the untouched Wi-Fi,
project, and settings data. Status records the rollback reason for Studio.

Project migrations may be staged only when both old and new schema ranges prove
compatibility. No irreversible project or settings migration occurs before the
new application is valid. An incompatible release is rejected at preflight.

### 4. One-time USB bootstrap for older cards

Firmware such as the current v1.1.1 card cannot receive a network update. The
public Studio uses its existing Web Serial path to bootstrap it without a
factory erase.

Before writing, Studio verifies all of the following:

- exact eFuse-derived Card ID, ESP32-S3 target, and 16 MiB flash;
- installed Lightweaver version/build identity read directly from flash;
- the committed partition-table bytes match the signed supported-layout
  digest;
- the installed application is the expected `app0` bootstrap source;
- the signed update ticket/image target and compatibility range accept the
  installed build;
- the application image fits entirely within `app0`;
- no write range intersects NVS, OTA selection data, `app1`, project storage,
  or any other data partition.

The bootstrap writes the signed application image at `0x10000` with erase-all
disabled, verifies an exact readback hash over the written image length, resets
the card into the application, releases USB, and waits for the same Card ID to
return on its saved local route. The new application then reports its preserved
project head and update capability.

The bootstrap deliberately does not rewrite the partition table, bootloader,
or OTA selection data. A power loss during this one-time same-slot write can
leave the application incomplete, but it cannot erase the preserved data
partitions. Recovery is to repeat the same USB bootstrap. Studio states this
bounded distinction; it never claims the bootstrap has A/B rollback.

If any eligibility fact is missing or mismatched, the preserving bootstrap
fails closed before writing. Factory recovery remains a separate, deliberate
last resort with an explicit recovery record.

### 5. Studio experience

For a verified connected card that supports network update, the primary action
is:

> **Update over Wi-Fi**  
> Keeps Wi-Fi, project, patterns, wiring, and settings.

The confirmation names the exact Card ID, installed and target versions/builds,
project head, preservation guarantee, and the one expected reboot. It requires
the physical confirmation gesture but no network or binary choices.

Studio shows acknowledged phases from the card rather than timers:

- Preparing card
- Sending signed update
- Verifying update
- Restarting card
- Reconnected to Card `<id>` on firmware `<version> · Build <number>`

Studio correlates the same Card ID, a changed Boot ID, the target firmware
identity, and the unchanged project head before reporting success. It restores
ordinary card control only after the new authority is established. If the card
rolls back, Studio says which build was restored and why.

For an older card, the primary action is:

> **Update once over USB**  
> Keeps Wi-Fi, project, patterns, wiring, and settings. Future updates use
> Wi-Fi.

The installer reads installed firmware directly, verifies bootstrap
eligibility, and never shows address/erase/file controls. Unsupported browsers
use the existing bounded Bridge handoff.

**Factory reset and reinstall** is visually separated under recovery and never
presented as the ordinary update action.

The public website does not scan nearby SSIDs. Routine updates do not need a
network selection because saved credentials remain on the card. When the
physical network truly changes, the card-hosted setup/recovery page may ask the
card to scan and present SSIDs locally; that is a separate recovery flow and no
password is returned to the public Studio.

## Failure behavior

- **Browser closes during upload:** the card expires the update lease, aborts
  the inactive slot, and continues the old firmware and project.
- **Browser closes after commit:** the card completes reboot/probation itself;
  reopening Studio reads the result.
- **LAN drops during upload:** the inactive write is abandoned; the active slot
  and data remain authoritative.
- **Power fails during network upload:** the active slot remains bootable; the
  incomplete inactive slot is ignored.
- **Power fails on first new-slot boot:** boot probation rolls back to the old
  slot.
- **New firmware is healthy but the router is offline:** the card stays on the
  new valid slot and offers its normal setup/recovery network.
- **Wrong card, changed boot, revoked authority, or changed project head:** all
  writes stop and require fresh exact-card validation plus physical
  confirmation.
- **Signature, target, layout, size, digest, application structure, capacity,
  API, or schema mismatch:** preflight or commit rejects without changing the
  active slot.
- **USB bootstrap interrupted:** preserved data remains; Studio instructs the
  owner to repeat the same bootstrap on the same card.
- **USB bootstrap eligibility unknown:** no preserving write occurs; Studio
  explains the unsupported source build/layout and offers recovery without
  silently factory-erasing.
- **Rollback succeeds:** Studio names the restored build and preserves the
  failed release evidence for diagnostics.
- **Both applications unavailable:** ROM USB recovery remains available;
  factory recovery is explicit and destructive.

No failure asks an ordinary owner to select a binary, flash offset, erase flag,
partition, or terminal command.

## Security and privacy

- Wi-Fi passwords never leave the card's existing data partition and are never
  displayed, copied, backed up, or uploaded by Studio.
- Update APIs are local-only, CORS allowlisted, size-bounded, rate-bounded, and
  unavailable without exact-card owner authority and physical confirmation.
- The card verifies a publisher signature with a pinned public key before
  committing an image.
- A digest without a valid signature is not authorization.
- Downgrades require an explicit recovery path and policy; an ordinary update
  never silently installs an older build.
- Raw firmware or preserved data bytes are not retained in browser storage,
  logs, diagnostics, or cloud services.
- Update status redacts credentials, owner capabilities, and private project
  content.

## Release and tooling changes

The release chain must:

- build the merged factory image and application-only image from the same
  source/build identity;
- reject identity, target, partition-layout, size, or embedded Card Studio
  disagreement between the two;
- construct and sign the canonical update ticket in the protected signer;
- extend provenance with the application image, ticket, signature, toolchain,
  partition layout, and exact workflow run;
- publish immutable URLs plus the existing factory alias;
- verify committed, artifact, and deployed bytes independently;
- classify updater firmware, release schema, signer, installer, and update UI
  changes as firmware-sensitive;
- retain the legacy factory image and Bridge as rollout recovery until the new
  paths are physically proven.

Production signing keys remain protected in CI. Tests use a separate committed
test public key/private fixture that production firmware cannot trust.

## Verification strategy

### Unit and contract tests

- Update ticket parsing is exact-key, bounded, deterministic, and rejects
  tampering, unknown fields, malformed signatures, wrong targets, and unsafe
  sizes/ranges.
- Studio and firmware agree on ticket digest, image digest, slot size, project
  schema, API compatibility, binding fields, sequences, and error codes.
- USB bootstrap range planning proves every written byte is within `app0` and
  cannot touch NVS, OTA data, `app1`, or project storage.
- Bootstrap accepts real supported signed historical images and rejects unknown
  layouts/source builds.
- Update state resumes truthfully after reload and never reports completion
  without new Card ID/Boot ID/build/project-head evidence.

### Firmware tests

- Wrong target, signature, hash, size, sequence, offset, binding, project head,
  schema, active-slot request, and concurrent mutation all fail closed.
- Transfer timeout and explicit cancel abandon the inactive slot and restore
  normal output authority.
- Commit selects only the verified inactive slot.
- Boot health confirms only after storage, project, renderer, controls, web,
  watchdog, and output initialization.
- Crash, watchdog reset, missing confirmation, corrupt image, and failed local
  health return to the previous slot.
- Network absence alone does not trigger rollback.

### Browser tests

- A connected capable card shows Wi-Fi update as the primary action and never
  asks for USB or credentials.
- An old card shows one preserving USB bootstrap, then the Wi-Fi-capable state.
- Progress follows card acknowledgements through reboot/reconnection.
- Closing/reopening before and after commit resumes the correct state.
- Wrong-card, revoked-authority, rollback, router-offline, and unsupported
  browser paths remain actionable.
- Factory reset remains separated and visibly destructive.

### Release tests

- Protected signer produces one coherent factory image, update image, ticket,
  ticket signature, manifest, manifest signature, and provenance set.
- Both images compile the same firmware/build identity and compatible Card
  Studio/API/schema identity.
- Staged Pages output and live build graph contain byte-identical immutable
  artifacts.
- Production firmware rejects the committed test signing key.

### Real hardware gates

On an exact recorded ESP32-S3 card:

1. Record Card ID, Boot ID, installed build, Wi-Fi route, project head and
   fingerprint, outputs, patterns, settings, and filesystem/NVS partition
   hashes that reveal no credential content.
2. Bootstrap from a supported old build over USB and prove the same Wi-Fi route,
   project head/fingerprint, settings, and data-partition hashes return on the
   new build.
3. Interrupt USB bootstrap writes at multiple offsets and prove data survives
   and the bootstrap is repeatable.
4. Perform a normal A/B Wi-Fi update and prove no USB picker, SSID selection,
   password entry, or manual reconnect occurs.
5. Interrupt network transfer, commit, first boot, and health confirmation;
   prove the old slot/project returns or the new healthy slot commits as
   specified.
6. Test browser close/reopen, router loss, mDNS loss, local-network permission
   revoke/re-allow, wrong card, power cycles, and explicit Stop/recovery.
7. Confirm actual lights return to the known-good look after success and every
   rollback. Only Adrian's physical observation can pass this visual gate.

No deployment report may call preservation or rollback physically proven until
these gates pass on real hardware.

## Rollout

1. Extend release artifacts and validators without changing the active factory
   installer.
2. Add the card-side signed updater, boot probation, status, and recovery
   contracts behind an update-capability flag.
3. Add preserving USB bootstrap eligibility and app-only flashing, still behind
   a capability/release flag.
4. Add Studio Wi-Fi update and USB-bootstrap flows; keep the existing factory
   and Bridge paths under recovery.
5. Prove USB preservation and A/B interruption behavior using production-shaped
   test signing on a dedicated bench card.
6. Ship a protected production release containing the updater, bootstrap one
   recorded old card, and verify its preserved state.
7. Prove the first production A/B update on that card before making Wi-Fi update
   the default for all compatible cards.
8. Keep factory/Bridge rollback available until multiple physical cards and
   supported browsers pass the matrix.

## Non-goals

- Unattended or scheduled card updates.
- Remote internet control or a cloud command relay.
- Exporting, displaying, backing up, or synchronizing Wi-Fi passwords.
- Public-website SSID scanning during a routine update.
- Changing the deferred Raspberry Pi or visitor UI paths.
- Removing factory USB recovery or the legacy Bridge during initial rollout.
- Allowing arbitrary, unsigned, user-selected firmware in the owner workflow.
- Claiming the one-time same-slot USB bootstrap has A/B rollback.

