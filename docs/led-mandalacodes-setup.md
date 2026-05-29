# led.mandalacodes.com setup

Goal: the Lightweaver browser UI lives at `led.mandalacodes.com`.

Current product rule: the public site is a Studio, installer, and support surface. It is not a Cloudflare relay and it does not provide pairing-code remote control. The ESP32 card owns runtime playback.

## Current recommended setup

Use a separate Cloudflare Pages project named `lightweaver`, built from `lightweaver/dist`, then attach `led.mandalacodes.com` as the custom domain.

Keep Mandala Codes as the parent/public brand site at `mandalacodes.com`. Do not fold the Lightweaver app into the Mandala Codes route tree unless we intentionally want shared navigation, styling, and release coupling.

## Why separate Pages project

- The Lightweaver app has different dependencies, build output, and hardware-facing behavior than Mandala Codes.
- A separate Pages project gives `led.mandalacodes.com` its own deployment history and rollback path.
- The Mandala Codes app can keep deploying from `technicianofthesacred/mandalacodes` without bundling LED controller code.
- Lightweaver can deploy from `technicianofthesacred/LED-Programming` or direct Wrangler uploads.

## Local build

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led/lightweaver"
npm run build
```

Important public routes:

- `/` - full Lightweaver app
- `/visitor` - simple visitor scene selector
- `/src/visitor/visitor.html` - raw Vite multi-page output for the visitor UI

## Cloudflare Pages deployment

Status on 2026-05-29:

- Cloudflare Pages project created: `lightweaver`
- Current Pages domain: `https://lightweaver-edw.pages.dev`
- Current custom domain: `https://led.mandalacodes.com`
- `https://lightweaver-edw.pages.dev/` returns HTTP 200
- `https://led.mandalacodes.com/` returns HTTP 200
- `https://led.mandalacodes.com/design/#screen=patterns` opens Studio v3
- `/api/lw/*` is intentionally excluded from Pages Functions and the old KV namespace has been deleted

One-time project creation:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led/lightweaver"
wrangler pages project create lightweaver --production-branch main
```

Deploy:

```bash
cd "/Users/adrianrasmussen/Documents/Files/2 Areas/Coding/led/lightweaver"
npm run deploy:pages
```

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
