# led.mandalacodes.com setup

Goal: the Lightweaver browser UI lives at `led.mandalacodes.com`.

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

Status on 2026-05-26:

- Cloudflare Pages project created: `lightweaver`
- Current Pages domain: `https://lightweaver-edw.pages.dev`
- Latest branch deployment: `https://codex-standalone-sequence-co.lightweaver-edw.pages.dev`
- `https://lightweaver-edw.pages.dev/` returns HTTP 200
- `https://codex-standalone-sequence-co.lightweaver-edw.pages.dev/` returns HTTP 200
- `https://codex-standalone-sequence-co.lightweaver-edw.pages.dev/visitor` returns HTTP 200 after Cloudflare's clean-URL redirect
- Custom domain `led.mandalacodes.com` is not attached yet; DNS did not resolve on 2026-05-26

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

## WLED control path

The UI can live publicly at `led.mandalacodes.com`, but the actual command path to WLED still needs one of these:

- direct local WLED access when the browser allows it
- WLED's built-in local UI
- Pi-hosted Lightweaver server using `lightweaver/server/index.js`
- a future local bridge/proxy

Reason: public HTTPS pages can be blocked from commanding private-network HTTP WLED controllers directly. The public UI should therefore detect when direct control fails and guide the operator to a local command path.

## Today checklist

- [x] Build `lightweaver`
- [x] Create or confirm Cloudflare Pages project `lightweaver`
- [x] Deploy `dist`
- [ ] Attach `led.mandalacodes.com`
- [x] Confirm `https://lightweaver-edw.pages.dev` loads
- [x] Confirm branch preview `https://codex-standalone-sequence-co.lightweaver-edw.pages.dev` loads
- [ ] Confirm `https://led.mandalacodes.com` loads after SSL activation
- [x] Test `/visitor`
- [ ] On the installation WiFi, test WLED connection behavior from a phone
- [ ] If direct WLED control is blocked, use WLED local UI or Pi/local bridge for commands
