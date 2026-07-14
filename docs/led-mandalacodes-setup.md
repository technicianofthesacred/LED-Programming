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
- **Gate:** the deploy only publishes when `CLOUDFLARE_API_TOKEN` (Pages: Edit)
  and `CLOUDFLARE_ACCOUNT_ID` are set as **Actions secrets on this repo**. Until
  then the deploy step skips cleanly and pushes never reach the live domain.
- **Do not** let the mandalacodes repo also publish to the `lightweaver` Pages
  project — the two would overwrite each other on the production branch. The
  mandalacodes site stays its own project serving `mandalacodes.com`.
- `scripts/go-live.sh` still targets the `studio` preview branch
  (`https://studio.lightweaver-edw.pages.dev`) for a dry-run before going live.

Trade-off of this repo owning production: `led.mandalacodes.com/` is the Studio;
there is no separate marketing landing page unless one is folded into this
repo's staged bundle (`stage:pages`).

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

The local `wrangler pages` command in use here does not expose a custom-domain subcommand, so the terminal path is Cloudflare's Pages API. Use a Cloudflare API token with `Pages Write` permission:

```bash
export CLOUDFLARE_API_TOKEN="paste-token-with-pages-write"

curl --request POST \
  "https://api.cloudflare.com/client/v4/accounts/fea8f6648edae8cf1e35032a3ae43611/pages/projects/lightweaver/domains" \
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
