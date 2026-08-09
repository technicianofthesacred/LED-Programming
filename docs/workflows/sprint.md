# Sprint mode

Sprint is the default mode for building features, fixing glitches, or working
through a list of issues. Adrian does not need to name the mode: requests such
as “fix these issues,” “keep iterating,” or “build this feature” invoke it.

Sprint optimizes for fast, integrated product progress. It does not authorize a
deployment, release signing, hardware flashing, or Prove run. Those boundaries
require their own explicit authorization.

## Dispatch

The primary agent remains the integrator and may dispatch at most three sub-agents.
Before dispatch, divide the batch into bounded workstreams with
non-overlapping ownership and non-overlapping files. Work that cannot be cleanly
separated stays with the primary agent or runs sequentially. The primary agent
alone resolves integration decisions and edits shared coordination state.

Use the balanced/default model for bounded independent work. Reserve the
frontier/deeper model for firmware, persistence, security, or cross-boundary
reasoning where a mistake can survive restarts, affect hardware, expose data, or
span multiple runtime contracts. Empty capacity is preferable to redundant or
low-leverage agents.

Each dispatched workstream receives:

- One outcome it owns end to end.
- Its exact file boundary and interfaces it must preserve.
- The focused verification required for completion.
- Any known dependencies, risks, or decisions it must return to the integrator.

## Workflow

1. Read the issue list and repository state. Group related issues into one
   coherent batch, separating only workstreams that can finish independently.
2. Assign ownership, record it on the workboard, and keep one stable preview for
   the batch.
3. For each defect or behavior change, establish focused evidence, implement the
   smallest coherent change, and rerun that focused check. Inspect the real
   screen for UI changes.
4. Put checks requiring Adrian's eyes in the visual-feedback queue. The
   visual-feedback queue does not block machine-verifiable work or other
   independent issues in the batch.
5. Integrate returned changes, inspect the combined diff for interface and file
   ownership violations, and resolve conflicts centrally.
6. Run exactly one integrated checkpoint after the coherent batch is assembled.
   Do not repeat the checkpoint per issue or per sub-agent. If it fails, repair
   the integrated cause with focused checks, then rerun that same checkpoint to
   obtain the batch's passing result.
7. Record completed evidence, remaining visual checks, and any follow-up issues.
   Stop at a verified, reviewable batch unless Adrian separately authorizes a
   release action.

## Evidence returned by each workstream

Return a compact packet to the primary agent:

```text
Outcome: <working behavior or exact blocker>
Files: <files changed>
Focused proof: <command/check and result>
Screen proof: <screen inspected, or queued human observation>
Risks/follow-ups: <remaining concern, or none>
Integration note: <contract, migration, ordering, or conflict concern>
```

“Done” means the owned outcome works under focused verification and the return
packet is complete. A sub-agent does not deploy, sign, flash, start Prove, run
the integrated checkpoint, or claim the whole Sprint complete.

## Timing and escalation

Target a useful batch in roughly 10–30 minutes. At 20 minutes, the primary
agent compares integrated working behavior with elapsed time and expected
consumption. If output is weak, reduce the batch or reorganize ownership. If the
work is trending past twice the estimate, tell Adrian immediately with the
working result, the specific blocker, and the smallest decision needed.

Escalate instead of guessing when an issue crosses an assigned file boundary,
requires destructive hardware recovery, changes a persistent data contract, or
needs Adrian's physical observation to distinguish causes. Physical observations
move to Bench mode; exhaustive release confidence moves to Prove only after its
explicit invocation.
