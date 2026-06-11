# led-art-mapper/pi-server — deprecated / unused

This directory is **deprecated and not used in the current ESP32-only plan**.

It was an early experiment at a Pi-hosted web server for the led-art-mapper tool.
It is superseded by `lightweaver/server/` (the WLED proxy and API server for the
deferred Pi integration lane).

**Do not add features here.** If Pi integration is ever resumed, use
`lightweaver/server/` as the canonical server, following `docs/pi-hosted-deployment.md`.

This directory is kept only as a historical reference and can be deleted when
the Pi lane is formally planned and `lightweaver/server/` is confirmed as its
replacement.
