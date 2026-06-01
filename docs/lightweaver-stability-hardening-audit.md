# Lightweaver Stability Hardening Audit

Date: 2026-06-01

## Scope

This audit covers the failure paths Adrian described: saving and loading Studio projects, loading a package onto the ESP32 card, switching functions/patterns, direct local-card writes, and public-site-to-local-chip handoff.

## Root Cause Map

Lightweaver has three state owners:

1. Browser Studio state: React state, autosave localStorage, project library localStorage, downloadable project files.
2. Card persistent state: ESP32 NVS `config` and `wifi`, optional SD `/lightweaver.json`, and the loaded runtime arrays used by the renderer.
3. Live control state: `/api/control` writes, bridge messages, Art-Net/WLED realtime frame sources, and physical rotary/button input.

Breakage appears when one owner updates while another is stale, unreachable, or receives an older command later than a newer command.

## Potential Problems and Hardening

| Area | Potential problem | Failure mode | Current/added hardening | Remaining hardening |
| --- | --- | --- | --- | --- |
| Studio autosave | Corrupt `lw_autosave_v3` JSON | Studio silently falls back to defaults or old legacy state | Added backup JSON helper and wired autosave to `lw_autosave_v3_backup` | Surface an explicit "recovered from backup" status in the UI |
| Project library | Corrupt `lw_project_library_v1` | Saved projects disappear on next library read | Added `lw_project_library_v1_backup` and recovery tests | Add export-all/import-all for disaster recovery |
| Project library | localStorage quota/private browsing | Save appears to work unless error is surfaced | Existing project-library save throws; tests cover unavailable storage | Autosave still needs visible failure status, not only `lastSaved` |
| Project load | Opening a saved project replaces unsaved current work | User loses a workspace after confirming the wrong project | Existing confirm dialog; active record tracking | Save a recovery snapshot before every library/file open |
| Draft pattern state | Unsaved pattern drafts live in a contributor, not the main project object | Autosave can miss draft state if contributor fails | Existing contributor try/catch protects autosave loop | Add a visible warning when a contributor throws |
| Card host | `.local` mDNS fails | Direct push goes to timeout | Existing parallel discovery tries remembered IPs/fallbacks | Persist proven hosts with card identity/MAC when firmware exposes it |
| Public HTTPS | Browser blocks `https -> http` card writes | Hosted Studio cannot command local ESP32 | Existing card bridge/handoff/copy-download paths | Add clearer bridge health in every card-writing screen |
| Wrong card | A default project saves over a real card layout | Chip changes from commissioned LED layout to default layout | Layout-mismatch guard blocks unintended geometry changes; Studio projects now carry stable `lwproj-*` ids; firmware exposes stored `piece.id`; Studio blocks writes to a configured card with a different project id | Add a visible recommission flow for intentional card/project reassignment |
| Config push retry | Retry after timeout can repeat a config write | Duplicate save/reboot requests | Existing retries are bounded | Add request idempotency keys in firmware responses |
| Config save without reboot | New NVS config can differ from current renderer arrays | Knob order or combo looks may not match until reboot | Firmware `/api/config` now returns `requiresReboot`; Studio and the local-card bridge honor it and request reboot after save | Later firmware can narrow this by live-applying same-layout configs and returning `requiresReboot:false` |
| Pattern switching | Rapid preview clicks send overlapping `/api/control` posts | A slower old request can arrive last and override the final pattern | Added latest-only live preview queue per card host | Extend sequence numbers into firmware for all control writes |
| Section switching | Card lacks target zone ids | Section preview silently controls nothing or the wrong section | Existing zone probe falls back to whole-card preview and explains save-needed state | Add one-click "restore section layout" before previewing a missing zone |
| External streams | Art-Net/WLED realtime keeps overwriting internal renderer | Pattern tile appears to do nothing | Existing `cancelStream` on control payload and Recover lights endpoint | Add status copy showing which stream source is active in Studio |
| Firmware JSON parse | Oversized outputs sum beyond fixed LED buffers | Unsafe LED geometry or failed render after pasted config | Added output clamping against remaining `LW_MAX_PIXELS` | Add response warning when clamping happened |
| Firmware zone ranges | Negative/out-of-range zone ranges | Zone renders dark because range exceeds total pixels | Added start/count clamping against loaded LED count | Add response warning and reject all-empty zone configs earlier |
| Firmware storage | NVS config corrupt | Card falls back to defaults or SD | Existing boot priority SD -> NVS -> defaults | Store a backup NVS config key and previous-good config metadata |
| Firmware heap | Large config parse on loop task stack | Stack pressure/reboot | Existing heap allocation for parsed config; source test covers it | Add free-heap threshold before accepting large config |
| SD priority | Old SD card overrides internal flash | Card "ignores" newly saved website config | Existing documented boot priority | UI should show current runtime source prominently before saving |
| Physical controls | Rotary/button uses stale controls until reboot | Press order or direction seems broken | Save-to-card copy says reboot when layout changes | Firmware live-apply for controls or always reboot after control config changes |
| Color order | Previewed order not persisted | Looks right until restart, then wrong | Existing live hardware preview status says save to keep | Firmware should echo persistent vs temporary hardware state |
| Hardware power/data | LEDs dark despite accepted commands | Software reports ok but pixels stay black | Existing Recover lights endpoint gives brightness diagnostics | Add installer checklist gate before blaming pattern state |

## Hardening Started

Implemented in this pass:

- Browser JSON storage now writes a backup copy and reads backup when the primary copy is corrupt.
- Project library saves maintain `lw_project_library_v1_backup`.
- Studio autosave uses `lw_autosave_v3_backup`.
- Live preview pattern writes are serialized per card host; while one preview is in flight, only the newest pending preview is sent next.
- Firmware config parsing clamps output pixels to the remaining fixed LED buffer.
- Firmware config parsing clips zone starts/counts to the loaded LED count.
- Firmware `/api/config` now returns `requiresReboot:true` after saving runtime config to internal flash.
- Studio direct pushes now reboot when firmware reports `requiresReboot`, even if the output layout comparison matched.
- The public-site local-card bridge now reboots when `/api/config` reports `requiresReboot`, while preserving conservative `if-needed` behavior for older bridge firmware.
- Studio projects now persist a stable `lwproj-*` id separately from the display name.
- Card runtime packages write that id as `piece.id`; firmware persists and reports it through `/api/firmware-info`.
- Studio config pushes now fail before writing flash when a configured card reports a different `piece.id`.
- Duplicating a saved project now creates a new project id, so project variants are not silently treated as the original card-paired project.
- Added regression tests for the storage backup, latest-only preview queue, firmware parser clamps, config-save reboot contract, and project/card identity guard.

## Next Hardening Priority

1. Add a visible recommission/override flow for intentional card/project reassignment after the project-id guard stops a save.
2. Add visible autosave failure/recovery state in Studio instead of silent catch blocks.
3. Add NVS previous-good backup on the ESP32.
4. Add control sequence ids so firmware can reject stale `/api/control` requests even if they arrive out of order.
5. Add a finer firmware config-commit contract: parse -> compare -> save -> live-apply same-layout controls/patterns when safe, otherwise return `requiresReboot:true`.
