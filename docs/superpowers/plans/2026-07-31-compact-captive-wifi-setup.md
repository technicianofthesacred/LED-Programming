# Compact Captive Wi-Fi Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ESP32 card's common first-time Wi-Fi form fit captive-login and phone viewports without shrinking its text or touch targets.

**Architecture:** Keep the existing `handleAdvancedRoot()` Wi-Fi APIs and polling behavior. Add a setup-only body class, compact setup CSS, essential-first markup with a native disclosure, and one zero-network disclosure hook; the normal card control branch remains structurally and visually isolated. Extend the existing Wi-Fi handoff source-contract test so the compact presentation cannot drift away from the proven handoff behavior.

**Tech Stack:** ESP32 Arduino C++, embedded HTML/CSS/JavaScript, Node.js source-contract tests, PlatformIO ESP32-S3 build

---

### Task 1: Lock the compact setup contract with a failing test

**Files:**
- Modify: `firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs`
- Test: `firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs`

- [ ] **Step 1: Add setup-region helpers and presentation assertions**

After `const advancedRoot = functionBody(...)`, add assertions that require the
approved structure without coupling to unrelated live-control markup:

```js
const setupMarkupStart = advancedRoot.indexOf('if (needsSetup) {');
const liveMarkupStart = advancedRoot.indexOf('} else {', setupMarkupStart);
assert.ok(setupMarkupStart >= 0 && liveMarkupStart > setupMarkupStart,
  'advanced page must keep a separate first-time setup branch');
const setupMarkup = advancedRoot.slice(setupMarkupStart, liveMarkupStart);

assert.match(advancedRoot, /<body class='/,
  'advanced page must expose a mode class for setup-only density');
assert.match(advancedRoot, /setup-mode/,
  'first-time setup must select the compact body mode');
assert.match(advancedRoot, /\.setup-mode \.wrap\{[^}]*safe-area-inset-top/,
  'compact setup must preserve safe-area padding without the spacious live shell');
assert.match(advancedRoot, /\.setup-mode (?:input\[type=text\],)?[^}]*font-size:16px/,
  'compact setup must retain 16px form text to avoid iOS focus zoom');
assert.match(advancedRoot, /\.setup-mode [^}]*min-height:44px/,
  'compact setup controls must retain 44px touch targets');

assert.ok(setupMarkup.includes('<h2>Join WiFi</h2>'),
  'setup must lead with the concise Join WiFi label');
assert.doesNotMatch(setupMarkup, /Join the card to your home WiFi/,
  'setup must not repeat a long explanation before the form');
assert.match(setupMarkup, /class='setup-network'/,
  'Network and Rescan must share the compact setup row');
assert.match(setupMarkup, /<details class='setup-options' id='setup-more'>/,
  'optional fields must use a native More options disclosure');
assert.match(setupMarkup,
  /<summary>More options<\/summary>[\s\S]*id='ssid-manual'[\s\S]*id='hn'/,
  'Hidden network and Hostname must remain available inside More options');
for (const [label, id] of [
  ['Network', 'ssid'],
  ['Password', 'pw'],
  ['Hidden network name (optional)', 'ssid-manual'],
  ['Hostname', 'hn'],
]) {
  assert.ok(setupMarkup.includes(`<label class='field' for='${id}'>${label}</label>`),
    `${label} must remain explicitly associated with ${id}`);
}
assert.match(setupMarkup, /id='msg'[^>]*role='status'[^>]*aria-live='polite'/,
  'join feedback must remain an announced status region');

assert.match(advancedRoot,
  /if\(!nets\.length\)\{setScanPlaceholder\([^}]*\$\('setup-more'\)\.open=true/,
  'a zero-network result must reveal the hidden-network recovery field');
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs
```

Expected: FAIL on the first missing compact-setup assertion while all earlier
handoff assertions still execute normally.

### Task 2: Implement the essential-first setup surface

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Test: `firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs`

- [ ] **Step 1: Give setup and live modes separate body classes**

Replace the fixed body opening at the end of the shared style block with a
three-part append so the existing `needsSetup` boolean selects the class:

```cpp
            "</style></head><body class='");
  page += needsSetup ? F("setup-mode") : F("control-mode");
  page += F("'><div class='wrap'>");
```

Keep the shared styles as defaults for the normal card surface. Add only scoped
overrides for setup:

```css
.setup-mode .wrap{max-width:520px;padding:max(12px,env(safe-area-inset-top)) max(14px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(14px,env(safe-area-inset-left))}
.setup-mode .head{margin-bottom:10px}
.setup-mode .card{padding:14px;border-radius:10px;margin-bottom:0}
.setup-mode .card h2{margin-bottom:5px}
.setup-mode label.field{margin:8px 0 4px}
.setup-mode input[type=text],.setup-mode input[type=password],.setup-mode select{height:44px;padding:8px 11px;font-size:16px}
.setup-mode button{min-height:44px;padding:10px 12px}
.setup-network{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end}
.setup-network #rescan{min-width:84px}
.setup-options{background:transparent;border:0;border-radius:0;margin:4px 0 0}
.setup-options summary{padding:8px 0 4px;font-size:12px;color:#9a8d75}
.setup-options .body{padding:0}
.setup-mode .join-row{margin-top:10px}
@media(max-width:300px){.setup-network{grid-template-columns:1fr}.setup-network #rescan{width:100%}}
```

- [ ] **Step 2: Emit only one setup identity**

Keep `<h1>Lightweaver</h1>` for both modes, but append `piece-name` only when
`!needsSetup`:

```cpp
  page += F("<div class='head'><h1>Lightweaver</h1>");
  if (!needsSetup) {
    page += F("<span class='piece' id='piece-name'>");
    page += escapeHtml(cfg.pieceName);
    page += F("</span>");
  }
  page += F("</div>");
```

- [ ] **Step 3: Replace the setup markup with the approved field order**

Use the existing element IDs so scanning and submission JavaScript remain
compatible:

```cpp
    page += F("<div class='card'><h2>Join WiFi</h2>"
              "<label class='field' for='ssid'>Network</label>"
              "<div class='setup-network'>"
                "<select id='ssid'><option value=''>Scanning…</option></select>"
                "<button class='ghost' id='rescan' type='button'>Rescan</button>"
              "</div>"
              "<label class='field' for='pw'>Password</label>"
              "<input type='password' id='pw' autocomplete='off'>"
              "<details class='setup-options' id='setup-more'>"
                "<summary>More options</summary><div class='body'>"
                  "<label class='field' for='ssid-manual'>Hidden network name (optional)</label>"
                  "<input type='text' id='ssid-manual' autocomplete='off' placeholder='Type a network name if it is not listed'>"
                  "<label class='field' for='hn'>Hostname</label>"
                  "<input type='text' id='hn' value='lightweaver'>"
                "</div>"
              "</details>"
              "<div class='row join-row'><button class='primary' id='join' type='button'>Save and join WiFi</button></div>"
              "<p class='note' id='msg' role='status' aria-live='polite'></p>"
              "</div>");
```

- [ ] **Step 4: Reveal recovery fields when scanning finds nothing**

Update `renderNets` without auto-closing the disclosure after a later result:

```js
const renderNets=nets=>{const sel=$('ssid');sel.innerHTML='';nets.forEach(n=>{const o=document.createElement('option');o.value=n.ssid;o.textContent=n.ssid+(n.rssi?' ('+n.rssi+'dBm)':'');sel.appendChild(o)});if(!nets.length){setScanPlaceholder('No networks found — rescan or type the name below');$('setup-more').open=true}};
```

- [ ] **Step 5: Run focused tests and verify the implementation passes**

Run:

```bash
node firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs
node firmware/lightweaver-controller/tests/wifi-project-preservation.mjs
node firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs
```

Expected: all three scripts exit 0 and print their success messages.

- [ ] **Step 6: Commit the tested implementation**

```bash
git add firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs
git commit -m "fix(firmware): compact captive WiFi setup"
```

### Task 3: Verify release safety and integrate

**Files:**
- Verify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Verify: `firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs`
- Verify: `docs/superpowers/specs/2026-07-31-compact-captive-wifi-setup-design.md`
- Verify: `docs/superpowers/plans/2026-07-31-compact-captive-wifi-setup.md`

- [ ] **Step 1: Run the complete source contract suite**

Run from `lightweaver/`:

```bash
npm run test:core:source
```

Expected: exit 0 with every Studio and firmware source contract passing.

- [ ] **Step 2: Compile the ESP32-S3 firmware**

Run:

```bash
pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8
```

Expected: `SUCCESS` for `esp32-s3-n16r8`, with no web-body guard or flash-size
failure.

- [ ] **Step 3: Inspect responsive and isolation contracts**

Confirm the final source contains setup-scoped CSS, the live branch is unchanged
apart from the body class and conditional piece label, and `git diff --check`
passes. At 320x568, 390px portrait, and the supplied Apple captive-login
proportions, verify the initial form shows Network, Password, More options, and
Save and join without document scrolling; opening More options may scroll.

- [ ] **Step 4: Commit the implementation plan after execution tracking**

```bash
git add docs/superpowers/plans/2026-07-31-compact-captive-wifi-setup.md
git commit -m "docs: add compact captive WiFi implementation plan"
```

- [ ] **Step 5: Fast-forward onto current remote main**

```bash
git fetch origin main --prune
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
```

Expected: the ancestry check exits 0 and the push advances `main` without force.
The protected firmware workflow may add its signed-release commit afterward.

- [ ] **Step 6: Verify remote workflows and the live signed release**

Watch the Tests, Build firmware binary, and replacement Deploy site workflows
for the pushed commit. Expected: Tests succeeds, firmware signing succeeds, and
the replacement deploy verifies the exact signed release on
`https://led.mandalacodes.com`.

- [ ] **Step 7: Restore the user's pre-existing local workspace state**

After recording the integrated commit and remote result, return the harness
worktree to detached `5d56d9b` and pop only the stash named
`preexisting-user-work-before-compact-captive-wifi`. Expected status:

```text
 M CLAUDE.md
 M INDEX.md
?? lightweaver/src/lib/patternLabRecipe.test.js
?? lightweaver/src/lib/patternLabStorage.test.js
```
