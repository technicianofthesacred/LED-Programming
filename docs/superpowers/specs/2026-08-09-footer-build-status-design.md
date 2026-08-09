# Lightweaver footer build status design

**Date:** 2026-08-09
**Status:** Approved for implementation

## Goal

Reduce the persistent Studio footer to the information Adrian needs on every screen:

1. which card Studio is connected to;
2. whether that card is running the current signed firmware release;
3. which Studio build is open; and
4. whether the temporary test-strip override is active.

The footer must make an outdated card actionable without implying that the Studio and firmware build numbers should match. Studio-only releases may advance the Studio build while the current firmware build remains unchanged.

## Information hierarchy

The desktop footer is one compact row in this order:

1. **Card connection:** status dot, card name and connection state. Clicking opens Connection Center.
2. **Firmware relationship:** the installed card build compared with the current signed firmware release.
3. **Studio identity:** freshness dot and Studio build number.
4. **Test strip:** one compact button while off; an expanded active state while on.

The persistent footer removes:

- pixel count from the card connection summary;
- GPIO and output details;
- firmware semantic version from the card connection summary;
- density, total LED count and strip count;
- idle push-rate telemetry; and
- verbose Studio freshness prose.

Those facts remain available in the surfaces that own them: Connection Center, Layout, Hardware settings and focused streaming controls.

## Display states

Examples use installed card build 1123, signed firmware release build 1154 and Studio build 1155.

| Condition | Footer firmware label | Behavior |
|---|---|---|
| Exact card and release build ID and number | `Card 1154 ✓` | Informational |
| Older signed card release | `Card 1123 → 1154` | Amber update action |
| Legacy card without a numbered build | `Card legacy → 1154` | Amber update action |
| Different build identity with the same or older number | `Card 1123 → 1154` | Amber update action |
| Development or unreleased card newer than the signed release | `Card 1160 · release 1154` | Informational warning; never offers a downgrade |
| Signed manifest unavailable or unverifiable | `Card 1123 · release unknown` | Warning; no update action |
| No connected card, signed release known | `Firmware 1154 available` | Informational; clicking may open Install or update |

The Studio label is always concise: `Studio 1155`. Its dot communicates current, checking, update-ready or unknown. Full revision and diagnostic prose remain available through the element's hover and keyboard-focus description.

The test-strip control renders only `Test strip` while off. When enabled it expands to `Testing 30 LEDs` with an attention treatment so the temporary override cannot be forgotten.

## Update interaction

Only `update-available` and `legacy` firmware states render the arrow as an update action. Activating it navigates to the existing **Install or update** screen for the currently signed release.

The footer does not authorize flashing and does not reuse status data as installation proof. The installer independently downloads and verifies the signed manifest, target, full image size, complete image SHA-256 and connected USB card before allowing an erase.

## Firmware release identity

### Installed card

The installed identity comes from the already verified card-link evidence:

- `link.card.buildNumber`, compiled into the card as `LW_BUILD_NUMBER`; and
- `link.card.buildId`, compiled into the card as the exact source revision.

The footer must not infer installed firmware from a remembered address, previous session or Studio release.

### Current signed release

Add a manifest-only release loader in installer-core. It:

1. fetches `/firmware/release-manifest.json` and `/firmware/release-manifest.sig` using `cache: no-store`, omitted credentials and redirect rejection;
2. verifies the ECDSA signature with the pinned Lightweaver release public key;
3. validates the complete manifest structure, target, semantic version, positive build number, immutable image URL and provenance; and
4. returns the verified manifest without downloading the firmware image.

The existing complete release loader must reuse this manifest-only boundary before downloading and hashing the image. This avoids duplicating signature policy and prevents the persistent footer from downloading approximately 1.3 MB merely to display a number.

Studio loads the signed release identity on startup and retries after returning online or when Studio freshness observes a newer deployed revision. Failure remains a truthful `release unknown` state.

## Relationship classifier

Implement a pure classifier that accepts installed card identity and verified release identity and returns one of:

- `current`;
- `update-available`;
- `development-build`;
- `legacy`;
- `release-unknown`; or
- `disconnected`.

Exact current status requires both build ID and build number to match. Build numbers alone are insufficient because divergent revisions can have the same commit count. A card with a greater build number is never automatically offered a downgrade. Missing or malformed evidence fails closed.

## Firmware semantic versions

The next signed firmware release is **1.1.0**.

Create one canonical firmware version source and make both compilation and manifest generation read it. Remove the duplicated hard-coded `1.0.0` release value from ordinary build configuration. Source fallbacks may remain only as explicit development safeguards and must be covered by consistency tests.

Provide a version-bump helper supporting:

- `patch` for fixes and reliability work;
- `minor` for backward-compatible card capabilities; and
- `major` for incompatible protocol or configuration changes.

Firmware-sensitive CI must compare the canonical source version with the previously signed release. It fails before signing when firmware source changed but the version did not advance, when the new version is not valid semantic versioning, or when it is reused or decreased.

The test compile, protected signer, signed manifest, immutable release directory, installer and card readback must all use the same exact version. The signer may not invent a different version after tests have run.

## Responsive behavior

Desktop remains one row. The card connection control retains the greatest flexible width; firmware and Studio builds never disappear.

On phone widths:

- the card connection summary collapses to card name and state;
- build labels may abbreviate to `FW 1123 → 1154` and `Studio 1155` while preserving accessible full names;
- diagnostic details remain in Connection Center; and
- Test strip moves to a short second row only when necessary.

The build identities must not be hidden at the existing 1024 px or phone breakpoints.

## Testing

### Unit and contract tests

- Classifier coverage for every display state, including equal numbers with different build IDs.
- Manifest-only signature verification, redirect rejection, malformed manifests and tampered signatures.
- Complete firmware loader reuse of the verified manifest-only boundary.
- Version helper patch, minor and major progression.
- CI rejection of unchanged, reused, decreasing or malformed firmware versions.
- Exact version agreement across compile configuration, firmware readback, manifest builder and signer workflow.

### Browser tests

- Connected current, outdated, legacy, development and unknown-release footer states.
- Disconnected footer with a verified available release.
- Outdated build action routes to Install or update without initiating a flash.
- Studio freshness remains concise while retaining full accessible diagnostics.
- Test-strip control expands only while active.
- Desktop and phone widths retain card, firmware and Studio identities without horizontal overflow.

### Release proof

A firmware-sensitive integration still requires the protected signer, production deploy and live readback. Shipment evidence must show:

- the live Studio build number;
- the live signed firmware release build number and semantic version; and
- the connected card's independently reported firmware build number and semantic version after flashing.

No automated test may mark the physical-card update gate passed.
