# Lightweaver public web deployment

The only customer-facing address is **[led.mandalacodes.com](https://led.mandalacodes.com)**. Put this address on cards, packaging, QR codes, worker instructions, and support material. Do not ask a customer to remember an IP address, `.local` hostname, `/design` route, or separate installer URL.

The public site is the Lightweaver hub for:

- designing and saving a piece;
- connecting or reconnecting an installed card;
- installing official firmware on a blank card;
- configuring GPIOs, outputs, and physical LED boundaries;
- previewing patterns with card acknowledgement;
- updating or recovering a card.

The card still executes LED commands locally. Studio opens a verified local card session when the browser requires it, but that transport is part of the guided connection flow rather than a second product entry point. `lightweaver.local`, `192.168.4.1`, and a card's numeric LAN address are technician diagnostics only.

## Routine action semantics

- **Install:** one primary **Install Lightweaver** action selects and verifies the official release. File pickers and flash addresses are not part of the customer flow.
- **Reconnect:** the Card Status control remembers stable card identity and offers one reconnect action. It does not require the customer to find or type an IP.
- **Recover:** **Recover Lights** runs the bounded recovery sequence and reports card acknowledgement, then asks whether light is physically visible.
- **Preview:** Studio changes immediately, but physical selection changes only after valid JSON with `ok:true`, expected-card identity, and applied look/revision proof. Superseded intent cannot become the confirmed physical state.

## Runtime boundary

The public HTTPS site owns project state, explanations, validation, and workflow orchestration. The ESP32 card owns playback, local credentials, hardware mutation, diagnostics, and acknowledgement. A customer starts at the public site and follows the one visible next action; Studio chooses the supported local transport.

This boundary is necessary because public HTTPS cannot directly command private HTTP devices in every browser. Mixed-content rules, private-network permissions, captive portals, and replaceable IP addresses still exist. Lightweaver handles them through the Connection Center and card-page bridge instead of exposing transport choices to the customer.

Do not use Cloudflare Workers KV as a card relay. The retired `/api/lw/*` path remains excluded from Pages Functions. Cards must not poll a public quota-backed transport.

## Production ownership

- Repository: `git@github-tech:technicianofthesacred/LED-Programming.git`
- Cloudflare Pages project: `lightweaver`
- Production branch: `main`
- Canonical URL: `https://led.mandalacodes.com/`
- Parent site: `https://mandalacodes.com/` is a separate deployment and must not publish over the Lightweaver Pages project.

The Studio is served at the subdomain root. `/design` is not part of the customer URL.

## Signed firmware release pipeline

Firmware changes are not ready to deploy merely because the source compiles.

1. Firmware or release-policy changes land on protected `main`.
2. `.github/workflows/build-firmware.yml` runs an unprivileged verification job using pinned PlatformIO and Node dependencies.
3. The protected `firmware-release` environment builds the merged factory image and accesses `LIGHTWEAVER_RELEASE_SIGNING_KEY`.
4. CI creates an immutable release path and manifest containing the target, firmware version, image size and SHA-256, config-schema range, minimum installer version, `buildId`, and toolchain provenance.
5. The manifest is signed with ECDSA P-256. Only the public verification key is shipped in Studio.
6. CI verifies the release, commits the complete signed release set back to `main`, and dispatches `.github/workflows/deploy-site.yml` when the artifact changed.
7. The Pages workflow runs the launch gate before publishing the root Studio and its signed firmware.

`buildId` and `provenance.sourceRevision` identify the exact source commit used to build the binary. `release-provenance.json` records the pinned PlatformIO, ESP32 platform/framework, and library versions. A source-only firmware commit intentionally makes the factory-binary freshness check fail until protected CI rebuilds and signs the artifact; never bypass that failure or manually publish the stale site.

The normal installer accepts only the pinned production target and a release whose signature, immutable URL, digest, size, installer version, config-schema range, and production firmware floor all validate.

### Production firmware version floor

`MINIMUM_PRODUCTION_FIRMWARE_VERSION` in `lightweaver/src/lib/firmwareRelease.js` is replay-safety policy, not the current release number. Raise it deliberately only when an older, correctly signed release is unsafe to install again. A floor change requires:

- a documented reason the older signed release is unsafe;
- a safe replacement firmware version already prepared;
- updated release-policy tests;
- a new protected CI build/sign cycle; and
- bench acceptance before production deployment.

Do not raise the floor for an ordinary feature release. Do not lower it to make a stale manifest pass.

## Release verification

Before merging or publishing:

```bash
cd lightweaver
npm run launch:check
```

After protected CI has committed the signed release and production has deployed:

```bash
cd lightweaver
npm run check:prod
```

The production check compares the live firmware with the committed artifact and verifies the root Studio shell. It may report `SKIPPED` while offline; that is not evidence of a successful production deployment.

## Cloudflare checklist

- [ ] `led.mandalacodes.com` is attached to the `lightweaver` Pages project and production branch `main`.
- [ ] SSL is active before QR codes are printed.
- [ ] The root URL opens Studio without `/design`.
- [ ] `/api/lw/*` remains retired and excluded from Pages Functions.
- [ ] `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured for the deployment workflow.
- [ ] The protected `firmware-release` environment owns the signing secret; feature branches cannot access it.
- [ ] The signed-release CI commit completed after the latest firmware source change.
- [ ] `npm run check:prod` passes against the deployed site.

## Technician diagnostics only

Support staff may inspect a card directly at `lightweaver.local`, `192.168.4.1`, or its confirmed LAN address when diagnosing network or firmware failures. These addresses are replaceable connection hints, never card identity and never customer onboarding instructions. Confirm the card's stable ID before any configuration, firmware, GPIO, or recovery mutation.
