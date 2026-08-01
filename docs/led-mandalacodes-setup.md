# led.mandalacodes.com setup

Goal: the Lightweaver browser UI lives at `led.mandalacodes.com`.

Current product rule: the public site is a Studio, installer, and support surface. It is not a Cloudflare relay and it does not provide pairing-code remote control. The ESP32 card owns runtime playback.

## Deploy ownership (updated 2026-07-13)

**This repo owns production at `led.mandalacodes.com`.** A push to `main` here is
the live deploy; there is no separate mandalacodes step for the LED surface.

- **Production** (`led.mandalacodes.com`, Pages project `lightweaver`, production
  branch `main`): `npm run deploy:pages` stages this repo's Studio (Show screen
  included) directly at `/` and runs `wrangler pages deploy … --branch main`.
  `.github/workflows/deploy-site.yml` runs it automatically on every push to
  `main` that touches `lightweaver/**`.
- **Gate:** the deploy only publishes when the complete credential, resource,
  and readiness set in [Production publish gate configuration](#production-publish-gate-configuration)
  is configured on **this repo**. Until then the deploy step skips cleanly and
  pushes never reach the live domain.
- **Do not** let the mandalacodes repo also publish to the `lightweaver` Pages
  project — the two would overwrite each other on the production branch. The
  mandalacodes site stays its own project serving `mandalacodes.com`.
- `scripts/go-live.sh` still targets the `studio` preview branch
  (`https://studio.lightweaver-edw.pages.dev`) for a dry-run before going live.

Trade-off of this repo owning production: `led.mandalacodes.com/` is the Studio;
there is no separate marketing landing page unless one is folded into this
repo's staged bundle (`stage:pages`).

## Production publish gate configuration

Production publishing always requires the storage, limit, library-readiness,
and operational credential set below. During the first dual-auth deployment it
also requires the Access set. After native acceptance, the exact GitHub variable
`LIGHTWEAVER_NATIVE_AUTH_READY=confirmed` removes only those Access requirements.
Names may appear in source; their real values must not.

- Credentials: `CLOUDFLARE_API_TOKEN` (Pages-only),
  `CLOUDFLARE_MIGRATION_API_TOKEN` (D1-only), and
  `CLOUDFLARE_ACCOUNT_ID`.
- Dual-auth proof: `LIGHTWEAVER_PREVIEW_ACCESS_READY=confirmed` after the
  protected preview acceptance passes. This remains required until native auth
  readiness is confirmed.
- Production readiness: `LIGHTWEAVER_PRODUCTION_LIBRARY_READY=confirmed`.
- Native cutover: keep `LIGHTWEAVER_NATIVE_AUTH_READY` unset until the first
  owner, password change/logout, and owner/worker/customer acceptance pass.
- Private storage: `PROJECTS_DB_DATABASE_ID`,
  `PROJECTS_DB_DATABASE_NAME`, and `PROJECT_BLOBS_BUCKET_NAME`.
- Transitional Access and roles: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and
  `OWNER_EMAILS`; these are required only before native cutover.
- Bounds: `MAX_LIBRARY_BODY_BYTES`, `MAX_LIBRARY_BACKUP_BYTES`, and
  `MAX_LIBRARY_BACKUP_REVISIONS`.

The GitHub Actions credential gate checks this complete set before it exposes
either operational credential to a migration or deployment command.

## Current recommended setup

Use a separate Cloudflare Pages project named `lightweaver`, then attach `led.mandalacodes.com` as the custom domain. This repository's Vite output is staged at the artifact root, so the custom-domain root is the canonical Studio URL while the hardware runtime remains on the ESP32 card page.

## Why separate Pages project

- A separate Pages project gives `led.mandalacodes.com` its own deployment history and rollback path.
- The main Mandala Codes project can keep serving `mandalacodes.com` and `www.mandalacodes.com`.
- The `lightweaver` Pages project can receive a direct Wrangler upload whenever the customer LED surface needs to move faster than the parent site.

## Local build

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led/lightweaver"
npm ci
npm run build
npm run stage:pages
npm run verify:pages
```

Wrangler is pinned exactly in `devDependencies` and `package-lock.json`. Use the
npm scripts after `npm ci`; do not replace them with an unpinned `npx` download.
The pinned Wrangler requires Node 22, which both the reusable test gate and
production deploy job use.

Important public routes:

- `/#screen=patterns` - visual pattern/color selection
- `/#screen=layout` - physical layout and wiring
- `/#screen=flash` - card firmware installer
- `/visitor` - visitor page
- `/firmware/lightweaver-controller-esp32s3-factory.bin` - factory firmware

## Cloudflare Pages deployment

Status on 2026-05-29:

- Cloudflare Pages project created: `lightweaver`
- Current Pages domain: `https://lightweaver-edw.pages.dev`
- Current custom domain: `https://led.mandalacodes.com`
- `https://lightweaver-edw.pages.dev/` returns HTTP 200
- `https://led.mandalacodes.com/` returns HTTP 200 and opens Studio v3
- `/api/lw/*` is intentionally excluded from Pages Functions and the old KV namespace has been deleted

## Private cloud project library

The Studio assets, installer, and card support routes stay public. Pages
Functions handle `/api/account*` and `/api/library*`; every other route remains
static. Cloudflare Access temporarily protects `/api/library*` only for first
owner bootstrap, then native sessions protect both APIs. No card URL, command,
credential, local hostname, or firmware request goes through either API; card
control remains on `lightweaver.local`, `192.168.4.1`, Web Serial, or the
card-page bridge.

### Current provisioning blocker

As of 2026-08-01, source and local release gates can be verified, but the cloud
library is not authorized for production deployment until the preview and
production D1/R2 resources, Access application, Pages bindings, and separate CI
credentials below exist. Keep
`LIGHTWEAVER_PRODUCTION_LIBRARY_READY` unset until the preview proof passes.
Keep `LIGHTWEAVER_PREVIEW_ACCESS_READY` unset until Pages Preview Access and
the preview Function audience have both been verified as described below.
There are intentionally no account IDs, database IDs, Access audience values,
email addresses, API tokens, or bucket credentials in this repository. Do not
run a remote migration or deployment merely to make an automated check green.

### One-time resource creation

Use the pinned Wrangler installed by `npm ci`. These are the canonical resource
names:

```bash
cd lightweaver
npm exec -- wrangler d1 create lightweaver-projects-preview
npm exec -- wrangler d1 create lightweaver-projects-production
npm exec -- wrangler r2 bucket create lightweaver-project-blobs-preview
npm exec -- wrangler r2 bucket create lightweaver-project-blobs-production
```

Do not paste the returned IDs into a tracked file. In **Workers & Pages →
lightweaver → Settings → Bindings**, configure both environments with these
exact binding names:

| Pages environment | `PROJECTS_DB` | `PROJECT_BLOBS` |
| --- | --- | --- |
| Preview | `lightweaver-projects-preview` | `lightweaver-project-blobs-preview` |
| Production | `lightweaver-projects-production` | `lightweaver-project-blobs-production` |

The buckets are private. In each R2 bucket's Settings, leave the public
development URL disabled and attach no custom domain. The Function accesses
objects only through the `PROJECT_BLOBS` binding; there are no public or
presigned object URLs.

For both Pages environments, configure `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
`OWNER_EMAILS`, `MAX_LIBRARY_BODY_BYTES`, `MAX_LIBRARY_BACKUP_BYTES`, and
`MAX_LIBRARY_BACKUP_REVISIONS`. `OWNER_EMAILS` is the comma-separated,
normalized exact identity list that receives the owner role; every other
identity admitted by Access is a worker. Missing Access, D1, or R2 configuration
fails closed rather than falling back to public data or browser-supplied role
headers. After native cutover, remove the three Access values from the generated
production runtime config; D1, R2, and all bounds remain mandatory.

### Cloudflare Access

For the bootstrap phase, create one self-hosted Access application for
`led.mandalacodes.com/api/library*`. Its Allow policy must use **Include →
Emails** with each approved exact email identity. Do not use Everyone, Login
Methods, an email-domain suffix, or any rule that admits every valid email.
Copy the application's audience into the protected `ACCESS_AUD` configuration
and the team origin into `ACCESS_TEAM_DOMAIN`; do not commit either value.

During bootstrap, the Function validates the Access assertion's signature,
exact issuer, exact audience, subject, and expiry on every request. After the
native owner is proven, remove this path application as described below. Log
out of the transitional Access session at:

```text
https://led.mandalacodes.com/cdn-cgi/access/logout
```

### CI credentials and configuration

Create two different account-scoped API tokens and restrict each to the
Lightweaver account:

- `CLOUDFLARE_API_TOKEN`: Pages Write only; no D1 administrative permission.
- `CLOUDFLARE_MIGRATION_API_TOKEN`: D1 Edit only (called D1 Write in the newer
  permission labels); no Pages or R2 administrative permission.

Add those as GitHub Actions secrets. Also add `CLOUDFLARE_ACCOUNT_ID`,
`PROJECTS_DB_DATABASE_ID`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and
`OWNER_EMAILS` as Actions secrets. Add the non-secret resource names and limits
as Actions variables: `PROJECTS_DB_DATABASE_NAME`,
`PROJECT_BLOBS_BUCKET_NAME`, `MAX_LIBRARY_BODY_BYTES`,
`MAX_LIBRARY_BACKUP_BYTES`, and `MAX_LIBRARY_BACKUP_REVISIONS`. Set the Actions
variable `LIGHTWEAVER_PREVIEW_ACCESS_READY=confirmed` only after the protected
preview acceptance below, then set
`LIGHTWEAVER_PRODUCTION_LIBRARY_READY=confirmed` when the complete production
configuration is ready. Create `LIGHTWEAVER_NATIVE_AUTH_READY` but leave it
unset until the native cutover acceptance passes. The workflow never prints any
value and never gives the normal Pages deploy token D1 migration authority.

### Migrations, preview, and production

Apply migrations locally before local binding tests:

```bash
cd lightweaver
npm exec -- wrangler d1 migrations apply PROJECTS_DB --config wrangler.local.toml --local
npm run test:cloud-bindings
```

Apply the same additive migration to preview, then deploy a non-`main` Pages
branch after its Preview bindings and variables are configured. The committed
`wrangler.toml` deliberately has no remote IDs, so do not deploy preview with
that bare configuration. Create the ignored, mode-`0600` file
`.wrangler/deploy/lightweaver-preview.toml` from this template, replacing every
angle-bracket placeholder locally:

```toml
name = "lightweaver"
compatibility_date = "2026-07-15"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "<absolute-lightweaver-path>/.pages/lightweaver"

[[d1_databases]]
binding = "PROJECTS_DB"
database_name = "lightweaver-projects-preview"
database_id = "<preview-d1-id>"
migrations_dir = "<absolute-lightweaver-path>/migrations"

[[r2_buckets]]
binding = "PROJECT_BLOBS"
bucket_name = "lightweaver-project-blobs-preview"

[vars]
ACCESS_TEAM_DOMAIN = "<access-team-origin>"
ACCESS_AUD = "<preview-access-audience>"
OWNER_EMAILS = "<approved-owner-identities>"
MAX_LIBRARY_BODY_BYTES = "<bounded-project-bytes>"
MAX_LIBRARY_BACKUP_BYTES = "<bounded-backup-bytes>"
MAX_LIBRARY_BACKUP_REVISIONS = "<bounded-revision-count>"
```

Create the ignored `.wrangler/deploy/config.json` with mode `0600` so Wrangler
uses that file for this one preview upload:

```json
{ "configPath": "lightweaver-preview.toml" }
```

Neither file may be committed. Delete both immediately after the preview
upload; the production deploy script creates and removes its equivalent
configuration automatically.

```bash
cd lightweaver
npm exec -- wrangler d1 migrations apply PROJECTS_DB --config .wrangler/deploy/lightweaver-preview.toml --remote
npm run build
npm run stage:pages
npm run verify:pages
npm exec -- wrangler pages deploy .pages/lightweaver --project-name lightweaver --branch library-preview
```

Preview deployment URLs are public by default. Before uploading any library
preview, open **Workers & Pages → lightweaver → Settings → General → Enable access
policy**. Manage the generated preview Access application, replace any
broad account/everyone rule with the approved exact-email identities, and
confirm it covers both hash and branch-alias preview URLs. Set the preview
Function's `ACCESS_AUD` to the preview Access application's audience—not the
production application's audience. A protected preview custom domain with its
own exact-email Access application is acceptable only when its actual audience
is used in the preview config.

On the protected preview URL, prove an approved worker can sign in, create, edit, reopen
history, download a master backup, and receives `403` for a direct permanent
delete. In a private browser with no Access session, request
`/api/library/session`; it must be denied and must include `Cache-Control:
no-store`. Confirm the signed-out preview root is also denied, and confirm the
staged `_routes.json` has the four account/library includes. Only after these checks
may `LIGHTWEAVER_PREVIEW_ACCESS_READY=confirmed` be set.

Production uses two safe passes. First, leave native readiness unset: the
workflow applies pending additive migrations (including `0002` and `0003`) with
the D1-only credential, deploys dual-auth code with the Pages-only credential,
and requires the Access denial live. Through the existing Access owner session,
use Studio's **Create owner account**, then prove native password change, logout,
login, owner/worker/customer authorization, customer draft isolation, and
backup. There is no public signup, email identity, or self-service recovery.

Only after that acceptance, remove the `/api/library*` Access protection, set
`LIGHTWEAVER_NATIVE_AUTH_READY=confirmed`, and rerun the same workflow. Its live
check now requires public Studio HTTP 200 plus unauthenticated no-store HTTP 401
responses from both account and library session APIs, and a generic invalid
login response. The workflow validates the canonical production D1 name and ID,
creates mode-`0600` temporary configs, and keeps migration and Pages credentials
separate. Dispatch the exact `main` commit with:

```bash
gh workflow run deploy-site.yml --ref main
```

Never run the production migration until the preview proof has passed and the
compatible source commit is the intended release.

### Backup restore and rollback

Before release, download the dated master `.lw-library.json` backup. In preview,
create a disposable project and reusable pattern, download another master
backup, restore it, and verify the restore is additive: existing records remain,
collisions become restored copies, every retained revision opens, and no card
or authentication data appears in the file. Keep an independent copy outside
browser storage and Cloudflare.

A Pages rollback changes code and static assets only; it does not undo D1
migrations or delete immutable R2 revisions. This release therefore permits
expand-only migrations, and every rolled-back Function must remain compatible
with the expanded schema. Master restore is additive and is not a database
rollback. For data recovery, first preserve the current master backup and R2
objects, then use D1 Time Travel only as an explicit incident operation; do not
assume it rewinds R2. Re-run authenticated create/open/history/backup,
unauthenticated denial, worker-delete denial, and live freshness proof after
any rollback or restore.

For native-auth rollback, restore the Access application and exact-email policy
first, unset or reset `LIGHTWEAVER_NATIVE_AUTH_READY`, and then deploy the prior
compatible Pages release. Do not reverse the account migrations.

One-time project creation:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led/lightweaver"
npm run pages:project
```

Deploy:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led/lightweaver"
npm run deploy:pages
```

`deploy:pages` builds, stages, verifies the root artifact (including the branded
404 that keeps the retired route unavailable), and only then invokes the pinned
Wrangler binary.

The deployed fallback URL will be:

```text
https://lightweaver-edw.pages.dev
```

## Custom domain

Cloudflare's Pages custom-domain flow must associate the domain with the Pages project. If the domain is under Cloudflare DNS, Cloudflare can usually create the DNS record during that flow. If not, create a CNAME manually.

The local `wrangler pages` command in use here does not expose a custom-domain subcommand, so the terminal path is Cloudflare's Pages API. Use a short-lived Cloudflare API token with `Pages Write` permission. Substitute local shell variables without committing or printing them:

```bash
curl --request POST \
  "https://api.cloudflare.com/client/v4/accounts/<account-id>/pages/projects/lightweaver/domains" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"name":"led.mandalacodes.com"}'
```

Dashboard path:

1. Cloudflare Dashboard
2. Workers & Pages
3. Pages project: `lightweaver`
4. Custom domains
5. Set up a domain
6. Enter `led.mandalacodes.com`
7. Complete validation and wait for SSL to become active

Manual DNS fallback:

```text
Type: CNAME
Name: led
Target: lightweaver-edw.pages.dev
Proxy: on
```

Do not only create the CNAME without associating `led.mandalacodes.com` to the Pages project. Cloudflare Pages expects the custom domain to be added to the Pages project first.

Verify after SSL activates:

```bash
curl -I https://led.mandalacodes.com/
curl -I https://led.mandalacodes.com/design  # must be exactly 404
cd lightweaver && npm run check:prod
```

For a preview deployment, override the one origin so the root, retired route,
and firmware checks cannot accidentally target different deployments:

```bash
PROD_ORIGIN=https://studio.lightweaver-edw.pages.dev npm run check:prod
```

## Card control path

The UI can live publicly at `led.mandalacodes.com`, but the actual runtime path stays local:

- the card's onboard page at `http://lightweaver.local` or `http://192.168.4.1`
- a copied/downloaded chip config from Studio v3
- direct local HTTP push only when the browser allows it
- optional Pi/local bridge work later, if intentionally added

Reason: public HTTPS pages can be blocked from commanding private-network HTTP controllers directly. The hosted Studio therefore defaults to copy/download/open-card instead of pretending it can reliably remote-control the card.

Do not reintroduce Cloudflare KV as a transport. A polling card burns quota and adds latency. If future remote control is required, use a deliberately provisioned persistent transport such as a WebSocket/MQTT service or Durable Object WebSocket, not KV polling.

## Today checklist

- [x] Build `lightweaver`
- [x] Create or confirm Cloudflare Pages project `lightweaver`
- [x] Deploy `dist`
- [x] Attach `led.mandalacodes.com`
- [x] Confirm `https://lightweaver-edw.pages.dev` loads
- [x] Confirm `https://led.mandalacodes.com` loads after SSL activation
- [x] Test `/visitor`
- [ ] On the installation WiFi, test card page loading from a phone
- [ ] Flash current firmware to existing cards so old relay-polling firmware is gone from hardware too
