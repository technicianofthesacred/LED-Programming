# Prove Lightweaver

Prove is the long, exhaustive confidence run for a fixed Lightweaver release.
It never starts automatically. The exact phrase **“Prove Lightweaver”** is the
authorization to begin.

A softer request such as “check everything” identifies a Prove candidate but
does not authorize it. Before starting, state the expected duration, explain
that a development freeze applies, and obtain Adrian's explicit confirmation.
“Ship,” “push to main,” and ordinary release work do not imply Prove and must
not silently invoke it.

## Entry gate

1. Confirm authorization using the rule above.
2. State the target release and realistic duration. Prove normally takes at
   least 20 minutes and may take longer when hardware observation is required.
3. Start a dated record from `docs/prove-sessions/TEMPLATE.md`.
4. Resolve and record the exact source revision, Studio build, firmware build,
   deployment target, and hardware target before running evidence.
5. Declare a **development freeze** on that target. Code, configuration,
   artifacts, and firmware remain unchanged until the run closes. A required
   change ends this run as incomplete; fix it in Sprint and start a new Prove
   record against the new revision.

The entry gate is complete only when the record identifies one immutable target
and the freeze is active.

## Evidence run

Run the following sections in order. Record the command or observation method,
UTC timestamp, target identity, result, and evidence location for every row.
Passing output without the command and target identity is not reusable proof.

### 1. Automated gates

- Run the complete release gate defined by `docs/development-workflow.md` and
  the launch gate required by `docs/deployment-checklist.md`.
- Include all browser, persistence, connection, save/load, transport contract,
  production build, and firmware checks applicable to the target.
- Record every skipped, timed-out, flaky, retried, or environment-blocked gate.
  A retry supplements the first result; it does not erase it.

This section is complete when every required automated gate has a reproducible
result or an explicit waiver.

### 2. Live production proof

- Verify the production deployment succeeded with real production credentials.
- Fetch `https://led.mandalacodes.com/studio-release.json` with cache bypassed
  and confirm its revision and Studio build match the frozen source revision.
- Verify the exact deployed files in the staged build graph, not only the
  release marker or a green workflow.
- Exercise the live Studio's critical open, edit, save, reload, reconnect, and
  card-communication paths that can be proven from the available environment.
- Record browser, URL, timestamps, release identity, and captured evidence.

This section is complete only when the live site is proven to be the frozen
target and each required live path has a result or explicit waiver.

### 3. Hardware matrix

Define the required card, browser/device, wiring, output, persistence, reboot,
reconnect, and representative lighting combinations before testing. For each
matrix row, record:

- card ID, boot ID, firmware build, project fingerprint, GPIO, pixel count,
  chipset, color order, current limit, and power/wiring setup;
- the machine action and machine evidence, such as flashing, serial output, API
  response, status read-back, browser action, or timing;
- the human observation separately, including pixel count, color, direction,
  startup appearance, animation stability, and unexpected flicker or resets;
- `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, or `WAIVED`, with evidence or reason.

Ask Adrian for one physical observation at a time. Automated evidence cannot
mark a visual hardware row passed. A configured card may be flashed only under
the recovery safeguards in `docs/development-workflow.md`.

This section is complete when every declared matrix row has a truthful status
and every `PASS` includes the required machine and human evidence.

## Close the run

Reconcile all automated, live, and hardware evidence against the frozen target.
Then record:

- every waiver, who accepted it, when, why, and the confidence it removes;
- every unresolved risk and its practical consequence;
- one unambiguous next action for resumption or release decision.

The outcome is **PROVEN** only when every required row passed or has an explicit
accepted waiver, the live revision matches the frozen target, and no unresolved
risk contradicts the claimed release behavior. Otherwise report **INCOMPLETE**
or **FAILED** and name the missing or failing evidence. Never convert an
unperformed check, unavailable device, blocked observation, or assumed visual
result into a pass.

