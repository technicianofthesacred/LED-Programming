# Unified Hardware Workspace Design

**Date:** 2026-07-17
**Status:** Data and safety requirements retained; UI architecture superseded by the shipped Card and Wire workspaces on `main`
**Product:** Lightweaver
**Runtime scope:** ESP32-S3 only; Raspberry Pi paths remain deferred

> **2026-07-18 integration note:** Do not implement the separate top-level Hardware route, Hardware overview, or duplicate calibration/install editors described below. Current `main` already ships one unified **Card** workspace and a five-step **Layout → Wire** commissioning workflow. The canonical remaining-work plan is [`../plans/2026-07-18-reusable-card-infrastructure.md`](../plans/2026-07-18-reusable-card-infrastructure.md). This document remains authoritative only for reusable multi-card data, power safety, templates, synchronization, history, and ESP32 runtime requirements that do not conflict with that plan.

## Historical UI outcome (superseded)

Lightweaver will replace the current top-level **Flash**, **Installer**, **Setup**, and hardware-related **Settings** destinations with one top-level **Hardware** workspace. Clicking Hardware opens the workspace immediately; it does not open a dropdown.

The workspace is a reusable toolkit for many different LED projects. It contains no Atlas-specific or installation-specific wiring assumptions. A project supplies its physical facts; Lightweaver supplies versioned templates, deterministic recommendations, card preparation, testing, synchronization, and installation records.

## Product boundaries

- A project may contain multiple ESP32-S3 controller cards.
- The live runtime remains ESP32-only. Do not revive the Pi proxy, Pi visitor UI, or Pi deployment work.
- Hardware templates are optional starting points. Applying a template creates an independent project-owned copy.
- Workshop and Install are two views of the same project/card records, not separate configurations.
- AI may explain recommendations, but safety validation and card-write gates must remain deterministic, versioned pure logic.
- No cloud catalog, account system, or global fleet-management backend is introduced.
- Templates, approval baselines, and as-built history must survive browser changes through project files and explicit exports; local storage may cache but may not be the only durable copy.
- Layout owns artwork geometry and route-only wire geometry. Hardware owns card-scoped GPIO/output assignments, power-domain assignments, electrical planning, card state, calibration, and verification. A GPIO is unique only within one card; two cards may legitimately use the same GPIO number.

## Navigation and information architecture

The main rail becomes:

- Layout
- Patterns
- Playlist
- Show
- Hardware

The footer contains **Project** and **Preferences**:

- Project owns the project name, BPM, palette/look defaults, project library, project file import/export, and other project-level non-hardware settings.
- Preferences owns application-only behavior such as theme, preview quality, and Studio display/performance settings.

Legacy routes remain permanent compatibility aliases:

- `#screen=flash` → `#screen=hardware&section=firmware`
- `#screen=flash&mode=install` → `#screen=hardware&section=firmware&mode=install`
- `#screen=installer` → `#screen=hardware&section=install`
- `#screen=production&job=…` → `#screen=hardware&section=firmware&action=prepare&job=…`
- `#screen=settings` → `#screen=project`. Project displays contextual links to Hardware and Preferences for controls that moved.

Canonical Hardware hashes use `#screen=hardware&section=<section>` where `<section>` is exactly one of `overview`, `controllers`, `power`, `firmware`, `tests`, `install`, or `history`. Optional parameters are serialized in this stable order after `section`: `card`, `mode`, `action`, `job`, `commissioning`, `returnCode`. Unknown sections resolve to `overview`; unknown parameters are retained through alias normalization but cannot authorize actions. Project and Preferences canonical hashes are `#screen=project` and `#screen=preferences`.

On initial load, aliases are parsed with all parameters intact and then replaced with the canonical Hardware hash using `replaceState`, so the browser back button does not bounce through an alias. Back/forward navigation operates on canonical hashes. The existing install-active navigation lock must continue working across aliases and canonical routes without dropping `job`, `mode`, `card`, commissioning, or return-code parameters.

## Hardware landing page

Hardware opens to a readiness dashboard. It is a decision surface, not a menu of six equal tiles. It shows:

- the selected controller and all other project controllers;
- stable card identity, connection state, firmware state, and project/card match status;
- one primary next action for the selected card;
- engineering blockers and recommendations;
- installation progress and the last approved/as-built snapshot;
- clear add-card and apply-template actions.

Examples of the primary action are: **Add first controller**, **Connect card**, **Resolve output mismatch**, **Install firmware**, **Continue tests**, or **Ready to install**.

## Hardware sections

### Controllers & outputs

Owns project controller instances, stable identity, host hints, LED type, voltage, output assignments, GPIO routing, pixel ranges, project-section mapping, and card replacement/supersession.

### Power & wiring

Owns PSU capacity, derating, voltage, expected current, firmware current ceiling, cable metadata, injection points, fusing, level shifting, common-ground confirmation, physical labels, and electrical recommendations. It reads wire-route geometry from Layout without becoming another geometry editor.

### Card & firmware

Owns connect, inspect, prepare, update, commissioning resume, and transport handoff. Firmware is conditional:

- matching firmware → Ready;
- blank card → Install;
- outdated card → Update;
- unsupported/recovery state → exact recovery action.

The existing automatic installer and production state machines are re-housed here rather than rewritten. Technician file selection, offsets, erase controls, and logs live under **Advanced repair**.

### Calibrate & test

Owns color order, count, direction, section mapping, blackout, staged-load verification, card readback, output gamma, and RGB balance. Gamma and RGB controls depend on selectively porting the completed `codex/led-output-correctness` contract and firmware work onto current production-safe main first. Browser-preview gamma remains a separate creative preview setting.

### Install & handoff

Turns the approved Workshop baseline into project-aware field instructions, card identification, wiring reference, guarded power-on sequence, guided tests, deviations, notes, and signoff. The existing static installer page is retired only after this generated flow covers its useful content.

### History & repair

Owns versioned approved baselines, as-built snapshots, production records, deviations, card substitutions, firmware history, diagnostic evidence, exports, and advanced repair tools.

## Canonical data model

Project version 4 introduces `devices.cards[]` as the single canonical controller-instance collection. Each card record has a stable project record ID even before a physical card is paired, and an optional stable hardware `cardId` after pairing.

Each card record owns:

- project role/name;
- template provenance and version;
- optional paired hardware identity and superseded identities;
- host/transport hints;
- runtime mode and firmware evidence;
- LED/output/electrical configuration;
- project-section and route assignments;
- calibration;
- approval baseline, verification state, and as-built snapshot references.

Migration rules:

- `devices.standaloneController` becomes `devices.cards[0].controller`.
- `devices.wledIp` becomes a host hint on the migrated first card.
- useful data from `devices.controllerProfiles` is merged into matching card records when identity is unambiguous; orphaned profiles are preserved as migration notes rather than silently discarded.
- v4 replaces `layout.wiring.outputs` with route-only `layout.wiring.routes`. A route owns geometry/order/run IDs and never owns a GPIO or card identity. Each card's controller outputs own GPIO and reference route/boundary IDs. Validation enforces the supported output count and unique GPIOs per card, never globally across all cards.
- v3 `layout.wiring.outputs` migrates atomically: route geometry becomes `layout.wiring.routes`, while each old `pin`/route assignment is attached to the first migrated card. v1/v2/v3 migrations are idempotent and retain unrecognized legacy material as migration notes.
- legacy fields remain readable through compatibility selectors during migration, but all new writes target `devices.cards[]`.
- serialization must be deterministic and round-trip through project save/load without losing legacy data.

Project-owned reusable records live in explicit collections: immutable versioned templates under `devices.hardwareTemplates`, immutable/content-addressed snapshots under `devices.hardwareSnapshots`, and ordered event references under each card's history. Imports validate references and reject or quarantine dangling records. Records are never silently pruned.

`controllerProfiles.js` is not adopted as a fourth persistent store. Its power estimation, readiness checks, test-state builders, Art-Net notes, and install-report logic are salvaged into focused pure libraries operating on the new card model.

## Multi-card connection and transport

The current singleton card-link state becomes a connection registry keyed by project card record ID and verified physical `cardId`. The UI may focus one active card while preserving the state of other project cards. Existing global identity/host storage is adopted automatically only when an all-project-library scan finds exactly one eligible candidate: one project containing exactly one migrated unpaired card whose empty/matching host hint is consistent with the legacy host/evidence, with no other project containing the same physical identity or host. If the library is unavailable, contains multiple eligible projects, contains conflicting evidence, or the current project has multiple logical cards, Lightweaver asks the operator to pair/read back explicitly and performs no mutation.

Every mutating request receives the expected project card record and physical card identity explicitly. Stale/wrong-card replies cannot update another registry entry. Card-page and native desktop Bridge sessions use per-card instance/window names and preserve the current origin, host, commissioning-resume, and expected-identity protections.

Every operation declares supported transports:

- direct local HTTP when browser security permits;
- card-page `postMessage` bridge for the public HTTPS Studio;
- the existing native desktop Bridge for unsupported-browser recovery and commissioning continuity;
- Web Serial on supported desktop Chrome/Edge for firmware preparation;
- copy/download handoff when direct writes are unavailable.

Mobile is primarily for Install view, card-page tests, readiness, wiring reference, and signoff. Web Serial preparation remains a desktop workflow and must offer a clear handoff instead of dead controls.

## Recommendations and safety

Recommendation results are versioned records with:

- severity: safe, recommendation, or blocker;
- rule ID and version;
- input facts;
- calculation/explanation;
- affected card/outputs;
- permitted resolution actions.

Project-level `powerDomains[]` own supplies/rails, voltage, usable capacity, derating, fusing, and injection metadata. Card outputs reference a power-domain ID. One voltage-aware power library aggregates every assigned output once per shared domain, then serves templates, Studio recommendations, production packages, firmware limits, and readback comparisons. It replaces conflicting 5V/60mA and 12V/12mA assumptions with explicit LED voltage and current-profile inputs. Conservative defaults are labeled and never presented as measured truth.

Card writes are blocked on unsafe or contradictory physical configuration. Overrides require a reason and remain visible. Low-power installation tests do not mutate the persistent `maxMilliamps` ceiling: they constrain diagnostic frame intensity beneath both the approved ceiling and the calculated safe test budget. Reload, disconnect, or crash therefore cannot strand a changed persistent cap; reconnect still verifies the approved ceiling by readback.

Install mode may correct color order, direction, labels, calibration, and verified pixel counts. Voltage, PSU capacity, controller topology, GPIO routing, and persistent power-limit changes create explicit deviations and invalidate the applicable Workshop approval boundary. Approval is a local project-state transition with recorded evidence; it does not introduce accounts.

## Required workflows

- add a blank logical controller;
- create from a reusable template;
- pair a pre-flashed card;
- install firmware on a blank card;
- update an outdated deployed card;
- resume an interrupted commissioning/bridge flow;
- compare project and card, then explicitly push, pull, or preserve;
- install multiple cards with per-card progress and resumable partial signoff;
- replace a failed card by superseding identity while preserving history;
- duplicate projects and clone templates without shared mutable state;
- operate safely when the card is offline or the current browser cannot reach it;
- preserve an external Art-Net/Madrix source mode without expanding it into a new subsystem.

**Pull** means importing only card-owned runtime/evidence fields that the firmware can prove: identity, firmware/build, applied output configuration, color order, calibration, current ceiling, output counts, wiring revision/digest, and active runtime metadata. It never reconstructs Layout geometry, templates, project history, or creative project content. Pull presents a field-level merge, and any accepted physical difference runs through approval invalidation.

Duplicating a project copies creative content, reusable templates, and component/power definitions, but creates a new project ID and clears physical card IDs, host hints, connection/commissioning sessions, Workshop approvals, deviations, production-run references, signoffs, and as-built history. Cloning a template creates a new immutable template ID/version with no shared mutable references.

## Production trust and multi-card coordination

Production remains one immutable signed job and one strict production run per physical card. Lightweaver does not introduce a multi-card signed job and does not relax exact project revision, release signing, firmware evidence, or same-card enforcement.

A project installation session coordinates references to independent per-card jobs/runs and may show partial progress across cards. Only one Web Serial production run is active on a workstation at a time. Completing one card stores its verified production record reference; pausing and resuming the project installation does not alter the signed job or its evidence.

Workshop approval may generate the input package for an individual card job, but it does not itself become production trust. The existing production-job builder validates exact schemas, creates the job digest, binds firmware/release identity, and enforces project revision. Adding output gamma/RGB fields requires a new optional production schema version, compatibility tests for old signed jobs, selected-card serialization, and regenerated/signable release artifacts.

## Reuse and retirement decisions

- Selectively port the verified output-gamma/RGB implementation from `codex/led-output-correctness` onto current `main`; do not merge the divergent branch wholesale or remove later production, commissioning, native Bridge, current-limit, identity, or wiring-safety work.
- Reuse the automatic install screen and commissioning logic inside Card & firmware.
- Reuse the production run, recovery, release-gate, physical-test, and record state machines without weakening their evidence rules.
- Keep technician flash tools intact under Advanced repair.
- Move Settings hardware controls into Hardware and refactor them into reusable section components.
- Move project-level creative defaults/file management to Project and app-only settings to Preferences.
- Retire the static Installer after the generated handoff and wiring reference have parity.
- Preserve card API origin/host validation, identity verification, transaction activation IDs, retry/reconnect behavior, and readback requirements.
- Preserve existing route-based Playwright tests through aliases, then add new tests for the unified paths.

## Delivery sequence

1. Selectively port the output-correctness prerequisite and extend the production job schema compatibly.
2. Split route-only Layout geometry from card-scoped GPIO/output assignments, then add project v4 `devices.cards[]`, project-level power domains, migrations, and compatibility selectors.
3. Add a per-card connection/Bridge registry with explicit expected-identity injection and safe singleton adoption.
4. Unify power calculations and expose persistent `maxMilliamps` through Studio/package/readback.
5. Add Hardware routes and relocate existing working screens/components with permanent legacy aliases.
6. Build the readiness dashboard and deterministic recommendations.
7. Add Workshop/Install views, deviations, generated wiring reference, tests, and signoff.
8. Add templates, as-built history, failed-card replacement, exports, and mobile handoff polish.
9. Retire the old static Installer and redundant hardware settings only after behavioral parity is verified.

## Acceptance criteria

- One top-level Hardware destination replaces Flash, Installer, Setup, and hardware Settings without losing a working flow.
- A project can persist, reload, connect, and independently manage at least two controller cards.
- The same GPIO may be used on different cards, but duplicate GPIOs within one card are rejected; each supported card may independently use its full output count.
- Existing single-card projects migrate without user re-entry and continue producing valid card packages.
- v1/v2/v3→v4 migrations are idempotent; multi-card and multi-project legacy identity ambiguity is never assigned automatically.
- Project/card comparison identifies the exact card and transport before any mutation.
- Stale or wrong-card direct, card-page Bridge, or native Bridge responses cannot mutate another card.
- Power recommendations and firmware current ceilings share one explicit calculation model.
- Shared power-domain capacity is aggregated once across assigned outputs; diagnostic caps never persist or require crash recovery.
- The readiness dashboard always presents one primary next action per selected card.
- Production setup, firmware recovery, and legacy deep links remain functional.
- Old signed production jobs remain readable/verifiable, while the new selected-card schema can carry output calibration without weakening exact validation.
- Install mode is usable on a phone for non-Web-Serial work and never presents unsupported controls as available.
- Templates and as-built history survive project export/import.
- Project duplication clears physical identity and installation evidence while retaining reusable design/template content.
- Automated tests cover migrations, route/card ownership, multi-card state, power domains, exact route aliases/install locks, direct/card-page/native Bridge fallbacks, wrong-card isolation, deviations, temporary diagnostic limits, old/new production schemas, templates, replacement, and all retained production/firmware behavior.
- New unit and Playwright suites are enumerated by `launch:check` rather than existing only as ad hoc commands.
- `npm run launch:check` passes before deployment, followed by the hardware/site smoke tests in `docs/deployment-checklist.md`.
- Physical acceptance includes two real cards, partial multi-card signoff/resume, explicit failed-card replacement, and full-load current verification.

This document is self-contained and is the implementation source of truth. Earlier local brainstorming HTML files are exploratory only and must not be used as requirements.
