# Lightweaver public web deployment

Canonical public Lightweaver UI URL: `led.mandalacodes.com`

Parent site: `mandalacodes.com`

## GitHub repos

- Lightweaver / LED repo: `git@github-tech:technicianofthesacred/LED-Programming.git`
- Mandala Codes repo: `git@github-tech:technicianofthesacred/mandalacodes.git`

## Recommended split

Use `led.mandalacodes.com` as the public-facing Lightweaver browser UI:

- scene/pattern selection
- WLED Basic setup and installation flow
- Art-Net / Advanced mode entry points
- installer/download entry point
- QR-code destination
- project overview and WLED setup instructions
- pattern package downloads
- links into local controller pages

Keep actual controller commands local:

- WLED built-in UI on the controller
- Pi-hosted Lightweaver UI on the installation LAN
- a local bridge/proxy running beside the controller

The reason is browser security. A public HTTPS UI cannot reliably control a private-network HTTP WLED controller from every phone/browser without a local command path. Mixed-content rules, private-network access restrictions, captive portal behavior, and local IP changes can all break direct control. Treat the public subdomain as the canonical UI home; treat WLED, the Pi, or a local bridge as the command surface when direct controller calls are blocked.

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
- Decide whether `led.mandalacodes.com` serves a standalone Lightweaver UI app or redirects/rewrites to a Mandala Codes route.
- Do not promise direct public-site-to-WLED control unless a local bridge or Pi proxy is part of the install.

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
- Keep WLED control local/Pi/WLED-served for Basic.
- Add I-64 OS only for advanced/admin integrations later.
