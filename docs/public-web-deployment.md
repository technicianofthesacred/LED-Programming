# Lightweaver public web deployment

Canonical public Lightweaver UI URL: `led.mandalacodes.com`

Parent site: `mandalacodes.com`

## GitHub repos

- Lightweaver / LED repo: `git@github-tech:technicianofthesacred/LED-Programming.git`
- Mandala Codes repo: `git@github-tech:technicianofthesacred/mandalacodes.git`

## Recommended split

Use `led.mandalacodes.com` as the public-facing Lightweaver browser UI:

- scene/pattern selection
- chip config setup and installation flow
- installer/download entry point
- QR-code destination
- project overview and card setup instructions
- chip package downloads
- links into local controller pages

Keep actual controller commands local:

- the Lightweaver card's onboard page on the installation LAN
- a local HTTP/file Studio session when direct push is needed
- a Pi/local bridge only if a future install explicitly includes it

The reason is browser security and quota safety. A public HTTPS UI cannot reliably control a private-network HTTP controller from every phone/browser without a local command path. Mixed-content rules, private-network access restrictions, captive portal behavior, and local IP changes can all break direct control. Treat the public subdomain as the canonical Studio and support home; treat the card page as the command and install surface.

Do not use Cloudflare Workers KV as a card transport. Cards polling a public KV-backed relay consume quota continuously and make the customer path depend on Cloudflare reads. As of 2026-05-29 the old `/api/lw/*` relay is removed, `/api/lw/*` is excluded from Pages Functions, and the KV namespace has been deleted.

## Mandala Codes vs I-64 OS

Mandala Codes is the better public home for the entry-level Lightweaver experience:

- already owns `mandalacodes.com`
- already deploys publicly through Cloudflare Pages
- matches the art/installation audience
- can host the Lightweaver UI without requiring an operator account

I-64 OS can still be useful later for internal/admin workflows:

- project records
- fleet/device registry
- client installs
- advanced Art-Net jobs
- operator-only dashboards

Do not make I-64 OS a requirement for the Basic WLED product.

## DNS / Cloudflare checklist

- Add `led.mandalacodes.com` as a custom domain in Cloudflare Pages, or create a separate Pages project for Lightweaver.
- Add the required `led` CNAME if Cloudflare does not create it automatically.
- Confirm SSL is active before printing QR codes.
- Confirm `led.mandalacodes.com` opens the Studio/support surface.
- Confirm `/api/lw/*` remains excluded from Pages Functions.
- Do not promise direct public-site-to-card control unless a local bridge or Pi proxy is part of the install.

## Route options

Fastest path:

- Add a `/lightweaver` route to the existing Mandala Codes app.
- Configure `led.mandalacodes.com` to serve or redirect to that route.
- Use it as the public Lightweaver UI, docs, setup, and package download surface.

Cleaner isolation:

- Create a separate Cloudflare Pages project for the Lightweaver UI.
- Attach `led.mandalacodes.com` directly to that project.
- Keep Mandala Codes focused on the oracle/deck site while still using the same parent domain.

Recommended choice for shipping:

- Use `led.mandalacodes.com` as the public Lightweaver UI surface.
- Keep card control local to the ESP32 page.
- Use Studio v3 to export what can actually be loaded onto the chip.
- Add I-64 OS only for advanced/admin integrations later.
