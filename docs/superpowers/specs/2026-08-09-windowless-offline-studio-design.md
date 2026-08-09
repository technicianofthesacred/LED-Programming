# Lightweaver Windowless Offline Studio — Design

**Date:** 2026-08-09
**Status:** Approved in conversation

## Goal

Make Lightweaver Studio and the physical card feel like one product in Chrome, Safari, Android, iPhone, and iPad. Routine design and live-light control must work with or without internet and must never require a second browser window, popup, or hidden bridge page.

The public HTTPS Studio remains the canonical full product. The card serves a compatible local Studio for browsers that cannot safely reach a local HTTP device from a public HTTPS page and for offline card control.

## Product contract

- Browsers that pass the real local-network capability probe stay at `https://led.mandalacodes.com` and talk directly to the exact card. Chrome and Edge are the expected first supported browsers.
- Browsers that do not pass the probe replace the current tab with the Studio served by `http://lightweaver.local`. Safari and iOS browsers are the expected fallback until their shipped behavior proves otherwise.
- Both routes use the same Lightweaver visual system, project schema, journey language, and card command contracts.
- No routine action opens or depends on an auxiliary window. The existing card-page bridge remains only as a temporary compatibility fallback while the new transports roll out.
- Layout, patterns, brightness, wiring tests, installation, Stop lights, recovery, project editing, and saved local looks work without internet.
- Secure-context-only tools—USB firmware flashing, microphone input, and cryptographic build/provenance features—must truthfully hand the user to the public HTTPS Studio. They are not presented as broken local controls.
- A successful API request never proves that the physical lights look correct. Existing explicit visual-confirmation contracts remain in force.

## Approaches considered

### Cloud relay

A cloud relay would be windowless and browser-independent while online. It fails the offline requirement and would add device credentials, infrastructure, remote authorization, and a larger attack surface. It is not the primary command path.

### Card-only Studio

Serving everything from the card would work offline, but an ordinary local HTTP origin cannot provide Service Workers, Web Serial, microphone access, or the public account session. It would make the least-capable environment the canonical product. This is rejected.

### Hybrid Studio — chosen

The public HTTPS Studio is the canonical full app and an installable offline-capable PWA. A pruned build of the same source is also served by the card. Runtime capability—not browser-name guessing—chooses between direct local-network transport and same-tab local Studio.

## Runtime architecture

### Public HTTPS mode

1. A deliberate **Connect this card** action makes one exact `GET /api/status` request to the selected host.
2. The request declares local address intent where the browser supports it.
3. Chrome or Edge may show the browser's local-network permission prompt.
4. Studio accepts the transport only after a fresh response matches the expected Lightweaver card identity, boot, firmware compatibility, and project authority.
5. The user stays on `led.mandalacodes.com`; all commands use direct HTTP transport.
6. Denied permission, unsupported behavior, or an unreachable card offers **Open local Studio**, which replaces the current tab.

The UI routes from the actual request result. It does not rely on user-agent sniffing or assume that an HTTPS page always requires a bridge.

### Card-local mode

1. Studio navigates the current tab to a bounded card URL such as `http://lightweaver.local/studio/`.
2. The card serves precompressed HTML, JavaScript, CSS, fonts, and small static assets embedded in its signed firmware image.
3. The local build uses same-origin card APIs and the same verified identity/readiness state machine.
4. **Back to online Studio** replaces the same tab with the canonical HTTPS URL. It never accepts an arbitrary return URL.
5. If the local Studio image is absent, corrupt, or incompatible, the existing small card control page remains available as a recovery surface.

The card-local build is not a separate handmade controller. It is a separate Vite target built from shared Studio components with local adapters and honest capability gates.

## Transport model

Card commands select one of three transport capabilities behind the existing card-link authority:

- `direct-lna`: public HTTPS Studio using browser-approved local HTTP requests;
- `local-origin`: card-served Studio using same-origin HTTP requests;
- `legacy-bridge`: temporary rollout and recovery fallback only.

Protocol checks must be removed from individual feature modules. Connection, push, live control, frame streaming, wiring safety, beacon, and bench installation all receive one verified transport authority from `cardLink`.

The current animated frame path must not assume that `ws://` is available through Local Network Access. The firmware and Studio will add a bounded HTTP frame-stream transport, with ownership, sequence, timeout, Stop, and recovery semantics equivalent to the current stream controller. WebSocket may remain an optimization only after real-browser proof.

Ordinary mutations require fresh exact-card correlation at operation start. Frame streaming uses a short-lived authority lease bound to the verified host, card, boot, operation generation, owner session, and stream sequence. The lease refreshes periodically rather than issuing an identity request before every frame. A host, origin, network, card, boot, owner-session, or operation-generation change revokes authority immediately and requires revalidation.

## Offline public Studio

The public Studio becomes an installable PWA:

- a generated Service Worker precaches the versioned application shell and hashed assets;
- hashed assets are cache-first;
- navigation HTML and the release marker are network-first with a version-compatible cached fallback;
- card and cloud API responses are never placed in the application cache;
- external fonts required for the interface are bundled locally;
- Studio gives the user a clear **Ready offline** state only after the required shell is stored;
- an update is activated through a controlled reload, never during an active card mutation or unsaved project transition.

This provides full offline editing at `led.mandalacodes.com` after one successful online load. It does not bypass Safari's local-network security boundary; Safari uses card-local mode for live card commands.

## Project storage and continuity

Public and card-local URLs are different browser origins and cannot share `localStorage`, IndexedDB, cookies, or Service Worker storage. Project continuity must therefore be explicit and conflict-safe.

### Repository seam

Project lifecycle code uses a `ProjectRepository` interface:

- `list()`
- `read(projectId)`
- `save(envelope, expectedHead)`
- `remove(projectId, expectedHead)`
- `watch(listener)`

Adapters are:

- IndexedDB repository for the public Studio;
- card repository adapter backed by a bounded firmware HTTP API and atomic writes to the card filesystem;
- existing cloud library adapter layered above the repository, not embedded in card commands.

Current project migration, validation, backup, and lifecycle rules remain above the repository. Existing browser projects migrate once from `localStorage` to IndexedDB with guarded readback and retain a recovery copy until migration is verified.

Each project envelope contains stable project ID, schema version, content hash, parent hash, local revision, modified time, source installation/card ID when applicable, and the complete editable project package. Timestamp-only last-write-wins is forbidden.

The installed card configuration is not treated as a full project backup. Hardware evidence can reconstruct outputs and counts, but not artwork and layout. The complete editable package is saved separately in the card repository.

A card save declares total bytes, chunk size, content hash, project ID, and expected head. Firmware writes bounded chunks to a staging file, verifies the complete staged file by hash and readback, atomically promotes a small head pointer, and only then retires the prior known-good version. Cancellation, timeout, reboot, or power loss leaves the previous head valid and cleans abandoned staging data on recovery. Delete and replacement require the expected head and explicit owner confirmation.

The repository reserves recovery headroom and checks its fixed quota before upload. The first release stores one active editable project plus one known-good recovery copy. An oversized project is rejected before destructive work begins and remains exportable from the browser; it never damages the installed project or current card project.

### First delivery: explicit transfer

The first safe version provides **Save project to this card**, **Export project**, and **Import project**. Offline local edits remain on the card until the user deliberately transfers or syncs them. The interface always names which copy is open.

### Online handoff

Seamless handoff is added after repository behavior is proven:

1. The public Studio creates an independent random lookup token and encryption key, encrypts the project bundle in the browser, then uploads only ciphertext to a size-limited, short-lived, single-use staging endpoint indexed by a hash of the lookup token.
2. It navigates the same tab to a bounded local URL with the lookup token and encryption key in the URL fragment. Fragments are not sent to the card server, logs, or referrers.
3. The local Studio makes an unauthenticated, lookup-token-authorized fetch of that one staged ciphertext bundle, keeps the encryption key client-side, decrypts and validates the bundle, binds it to the exact card identity, migrates it through the normal project model, and consumes the lookup token.
4. Returning online uploads ciphertext through the same narrow one-time endpoint, then uses top-level navigation to the public origin. Only the public top-level page can use the existing Secure, HttpOnly, SameSite=Strict account session to complete an authenticated cloud save.

No reusable cloud credential, account cookie, plaintext project JSON, or permanent bearer token is stored on the card or included in a URL. The staging server receives the one-time lookup capability but never receives the independent decryption key. Concurrent edits produce an explicit compare/keep-both/replace decision using parent hashes; they never merge silently.

## Card bundle and firmware lifecycle

The current production Studio assets are approximately 3.0 MB raw and 887 KB compressed. The current firmware is approximately 1.31 MB inside each 6.25 MB OTA application slot, so a pruned, precompressed local build can travel inside the signed firmware while remaining well within the measured slot budget. The existing approximately 3.375 MB filesystem partition then remains available for editable project packages and recovery data.

The build pipeline creates:

- a card-local Studio bundle linked into the signed firmware application image;
- a `card-studio-release.json` containing build identity, project-schema range, firmware API range, asset hashes, and total size;
- a signed release manifest that covers the combined firmware and local-Studio image;
- installer verification for the combined image's exact offset, hash, size, and readback.

The firmware serves the embedded compressed files with immutable caching for hashed assets and no-cache behavior for HTML/release metadata. Firmware and its local Studio therefore update atomically. The local build still publishes an explicit compatibility identity and checks it before enabling mutations. An incompatible or damaged build keeps the existing small recovery page and safe pattern, brightness, blackout, and recovery controls available while directing the user to update.

The card's synchronous web server shares time with LED playback. Real-card gates must prove that first-load and repeated asset delivery do not visibly stall animation. If they do, serving is chunked/yielded or moved behind a measured scheduling boundary before release.

microSD may provide an override or recovery source later, but it is not required for normal Studio availability. The deferred Raspberry Pi and visitor-ui paths remain untouched.

## Connection experience

The contained Connection Center becomes the only owner connection entrance.

- The primary action says **Connect this card**.
- Before the first direct attempt, Chrome/Edge copy explains the local-network prompt and tells the user to choose Allow.
- Failure copy does not pretend it can distinguish permission denial from network failure when the browser hides that detail. It asks the user to check the same Wi-Fi and local-network permission.
- Recovery actions are **Try again** and **Open local Studio**.
- Wrong-card evidence blocks all writes and identifies the mismatch.
- Any browser whose real direct probe does not succeed uses the same-tab local route; browser names are explanatory copy only, never routing logic.
- No action calls `window.open()` for routine card connection or control.

## Security and safety

- Local-network permission grants network reachability, not card authority.
- Firmware CORS remains restricted to canonical Studio origins; wildcard credentialed CORS is forbidden.
- Local Studio never receives a reusable public account token.
- Every project transfer is exact-card-bound, short-lived, size-limited, single-use, and schema-validated.
- Complete card-project read, write, replace, and delete operations require a short-lived owner capability bound to the exact card, boot, origin, and expected project head. The capability is established through existing commissioning authority or a deliberate physical-presence pairing action; it cannot be acquired silently by another LAN page. Public browser calls retain strict origin/CSRF checks, and local same-origin alone is never treated as ownership.
- Every mutation preserves the existing exact identity, boot, readiness, owner-capability, and operation-generation guards.
- Stop lights and recovery use the canonical verified APIs and remain available throughout physical testing.
- Final installation keeps staged candidate, explicit visible confirmation, commit, and independent readback ordering.
- The legacy bridge is not removed until direct and local modes pass the real-device matrix and deployed telemetry shows a safe migration path.

## Delivery stages

1. **Capability spike:** prove Chrome/Edge direct requests and bounded HTTP frame delivery on real cards; prove Safari/iOS same-tab navigation and local asset serving.
2. **Unified transport:** centralize capability routing behind `cardLink`; add Connection Center permission and fallback UX; retain bridge fallback.
3. **Offline public Studio:** add PWA shell, local fonts, IndexedDB repository, migration, durable cloud outbox, and update safety.
4. **Card-local Studio:** add shared-source local build, same-origin adapters, signed firmware embedding, firmware server, compatibility gate, and recovery fallback.
5. **Explicit project continuity:** full project package on card, import/export, source labeling, and conflict-safe repository semantics.
6. **Secure online handoff:** one-time project transfer and explicit conflict resolution.
7. **Bridge retirement:** remove auxiliary-window dependence only after all required browsers and hardware recovery cases pass.

Stages are independently releasable and must not weaken the current working bridge before their replacement is proven.

## Verification

Automated contracts must cover:

- direct capability selected from a successful exact request, not protocol or browser name;
- permission denial/unreachable recovery and same-tab fallback;
- zero popup/window creation in direct and local modes;
- exact-card mismatch and authority revocation on host/origin/network/boot changes;
- every card command family through `direct-lna` and `local-origin`;
- HTTP frame ownership, ordering, Stop, timeout, interruption, and recovery;
- short-lived stream-authority lease refresh and immediate revocation on identity/session change;
- PWA cold offline start after installation and controlled update behavior;
- IndexedDB migration, readback, quota/error recovery, and durable outbox replay;
- complete card project save/read and proof that installed config alone is not called a full project;
- chunked staging, quota rejection, expected-head replacement/delete, power-loss recovery, atomic head promotion, and retained known-good project behavior;
- explicit conflict handling with no timestamp-only overwrite;
- signed embedded-bundle packaging, hash/readback failure, bundle incompatibility, card-project capacity failure, atomic recovery, and fallback card page;
- secure-only tools handing back to HTTPS rather than failing locally;
- token-fragment handoff, ciphertext-only staging, single-use expiry, strict-cookie top-level claim, and card owner-capability rejection;
- no regression to Setup, Strip Discovery, Layout/Wire, final install/readback, Patterns, and card controls.

The real-device matrix includes macOS Chrome, Edge, and Safari; Android Chrome; iPhone Safari and Chrome; iPad Safari; normal router Wi-Fi; the card access point at `192.168.4.1` with no internet; internet loss after load; reload; background/resume; private mode; permission allow/deny/revoke; wrong card; reboot; Wi-Fi handoff; pattern selection; frame streaming; Stop; install/readback; and return-online conflicts.

Every matrix case asserts that no auxiliary window or tab is required. Human-observed tests confirm that animation remains smooth while the card serves Studio files and that physical light correctness is never inferred from network success.

## Success criteria

- A Chrome/Edge user can open the public Studio, allow local-network access, control the exact card, lose internet, and continue without another window.
- A Safari/iOS user can move into the card-local Studio in the same tab and perform routine design and card control fully offline.
- The complete editable project is recoverable from its declared repository and never silently overwritten across origins.
- A damaged or incompatible local Studio cannot strand the card; the small recovery page and signed installer remain usable.
- Setup, live patterns, Stop, recovery, final physical confirmation, and exact readback remain truthful and safe.

## Out of scope

- Raspberry Pi runtime work or the deferred `visitor-ui/`.
- A cloud relay as the primary command path.
- Remote card control over the internet.
- Reusable cloud login credentials on the card.
- Claiming that local HTTP can provide Web Serial, microphone, Service Worker, or every public secure-context feature.
- Removing the bridge before the replacement passes the complete real-browser and real-card gates.
