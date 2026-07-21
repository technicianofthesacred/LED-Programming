# Card provisioning checklist (superseded)

Use [`new-card-checklist.md`](new-card-checklist.md) for every ESP32-S3 card.
That checklist is the current no-code production procedure and shipment gate.

The former checklist required manual card addresses and GPIO discovery. Those
steps are no longer accepted production recovery: Studio must automatically
track the exact card through the AP-to-LAN handoff, and the canonical bench job
must load the known GPIO 18 project.
