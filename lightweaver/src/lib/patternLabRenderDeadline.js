// Pattern Lab render-deadline policy — how long an in-flight render may take
// before the preview reacts, and what "how long" even means on a device that
// falls asleep.
//
// WHY THIS IS A MODULE AND NOT TWO CONSTANTS IN THE HOOK
//
// The owner streams Pattern Lab's frames to a physical piece continuously while
// he works: the browser preview is not the preview, the artwork on the wall is.
// So this policy does not govern a picture on a laptop — it governs whether his
// installation keeps playing. It is worth stating as pure, testable functions.
//
// TWO CLOCKS, NOT ONE, BECAUSE THEY BUY DIFFERENT THINGS
//
//   degrade  — drop this render to the preview sample budget. Cheap, reversible,
//              self-healing: the next frame that arrives clears it, and on the
//              lights it is at worst slightly coarser. Being trigger-happy here
//              costs the owner nothing, so it stays at 400 ms.
//   give up  — throw the worker away, and (after the replacement cap) stop the
//              pattern entirely, which also takes the piece off the live stream.
//              Destructive and not silently recoverable, so it gets a materially
//              larger margin: 1500 ms per missed deadline, three in a row.
//
// WHY 400 / 1500 AND NOT SOMETHING ELSE
//
// Measured on the heaviest configuration this app can build (reaction-diffusion,
// two layers, 1024 samples, 8000 pixels): median render under 1 ms, worst single
// frame 14.3 ms. Render time is not what crosses these deadlines. A device would
// have to be ~29x slower than the dev machine to miss 400 ms on render work, and
// ~105x slower to miss 1500 ms. What actually crosses them is the main thread not
// running at all — GC, CPU contention, and above all a hidden tab or a locked
// phone — which is why hidden time is excluded entirely (below).
//
// The honest cost of the larger destructive margin: a pattern that genuinely
// never terminates (the worker's own `while (true)` test path, or a user-authored
// pattern that does the same) is reported after ~9.4 s of awake time instead of
// ~2.8 s — three 1500 ms strikes, one replacement, three more strikes. The page
// stays fully responsive throughout, because the code that will not finish is in
// its own thread; the only thing that waits is the message telling the owner so.
export const RENDER_DEGRADE_MS = 400;
export const RENDER_GIVE_UP_MS = 1500;
// Three consecutive missed give-up deadlines before a worker is treated as
// unresponsive — unchanged from when both clocks were one, because the strike
// count is about "it said nothing at all", not about the length of the window.
export const RENDER_GIVE_UP_DEADLINES = 3;
// A page that has just come back from being hidden has a cold main thread: the
// resume itself, the queued messages that piled up, and whatever the OS wants to
// do first. Nothing escalates during this much AWAKE time after a resume, so the
// first tick back never fires on a backlog. It is short on purpose — the worker
// was never frozen, so a healthy reply is usually already sitting in the queue.
export const RENDER_RESUME_GRACE_MS = 250;

// Tracks how long a single in-flight render has been waiting, counting ONLY the
// time the page was awake.
//
// The bug this exists for: the old clock was `performance.now() - postedAt`, raw
// wall time. Lock the phone for thirty seconds mid-stream and that clock reads
// 30000 ms the instant anything looks at it — seventy-five missed deadlines —
// so the preview escalated all the way to "this pattern is too heavy" while the
// owner was simply not looking. Hidden time is not evidence of a slow render.
//
// It is bounded, not forgiving: awake time already spent before the page hid is
// still owed. A render that burned four seconds of visible time and then hid does
// not come back with a clean slate, it comes back at four seconds.
export function createRenderDeadlineTracker({ startedAt, hidden = false } = {}) {
  const origin = Number.isFinite(startedAt) ? startedAt : 0;
  let banked = 0;
  let markedAt = origin;
  let isHidden = Boolean(hidden);
  // Awake-elapsed reading at the most recent hidden -> visible transition, so the
  // grace window is itself measured in awake time and a second lock during the
  // grace cannot extend it into forever.
  let resumedAtAwake = null;

  function awakeElapsed(at) {
    const now = Number.isFinite(at) ? at : markedAt;
    return isHidden ? banked : banked + Math.max(0, now - markedAt);
  }

  function bank(at) {
    const now = Number.isFinite(at) ? at : markedAt;
    if (!isHidden) banked += Math.max(0, now - markedAt);
    markedAt = now;
  }

  return {
    get hidden() { return isHidden; },
    setHidden(nextHidden, at) {
      const next = Boolean(nextHidden);
      if (next === isHidden) return false;
      bank(at);
      isHidden = next;
      if (!next) resumedAtAwake = banked;
      return true;
    },
    awakeElapsed,
    // Awake ms since the page last came back, or null if it never hid.
    awakeSinceResume(at) {
      if (resumedAtAwake === null) return null;
      return awakeElapsed(at) - resumedAtAwake;
    },
  };
}

// The whole verdict for one in-flight render, as a pure function of its clock.
//
//   ok       — say nothing.
//   degrade  — sample down and tell the owner the preview is coarser. Reversible.
//   give-up  — the worker is not answering; replace it, and past the replacement
//              cap stop the pattern.
export function classifyRenderDeadline({
  awakeElapsed = 0,
  hidden = false,
  awakeSinceResume = null,
} = {}) {
  // A hidden page is not a slow one. Nothing escalates while nobody is looking,
  // and nothing resets either — the clock simply stops.
  if (hidden) return { level: 'ok', degraded: false, missed: 0 };
  if (awakeSinceResume !== null && awakeSinceResume < RENDER_RESUME_GRACE_MS) {
    return { level: 'ok', degraded: false, missed: 0 };
  }
  const missed = Math.floor(awakeElapsed / RENDER_GIVE_UP_MS);
  if (missed >= RENDER_GIVE_UP_DEADLINES) return { level: 'give-up', degraded: true, missed };
  if (awakeElapsed >= RENDER_DEGRADE_MS) return { level: 'degrade', degraded: true, missed };
  return { level: 'ok', degraded: false, missed: 0 };
}
