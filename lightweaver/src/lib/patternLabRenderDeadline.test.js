import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDER_DEGRADE_MS,
  RENDER_GIVE_UP_DEADLINES,
  RENDER_GIVE_UP_MS,
  RENDER_RESUME_GRACE_MS,
  classifyRenderDeadline,
  createRenderDeadlineTracker,
} from './patternLabRenderDeadline.js';

function verdictAt(tracker, at) {
  return classifyRenderDeadline({
    awakeElapsed: tracker.awakeElapsed(at),
    hidden: tracker.hidden,
    awakeSinceResume: tracker.awakeSinceResume(at),
  });
}

test('the destructive threshold is materially larger than the reversible one', () => {
  assert.equal(RENDER_DEGRADE_MS, 400);
  assert.equal(RENDER_GIVE_UP_MS, 1500);
  assert.ok(RENDER_GIVE_UP_MS >= RENDER_DEGRADE_MS * 3);
  // Worst measured healthy frame on the heaviest configuration is 14.3 ms. The
  // destructive path must keep a margin of at least 100x over it, or a merely
  // slow phone loses its pattern instead of getting a coarser one.
  assert.ok(RENDER_GIVE_UP_MS / 14.3 > 100);
});

test('a healthy render says nothing at all', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  assert.deepEqual(verdictAt(tracker, 14.3), { level: 'ok', degraded: false, missed: 0 });
  assert.deepEqual(verdictAt(tracker, 399), { level: 'ok', degraded: false, missed: 0 });
});

test('a slow render degrades long before anything destructive happens', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  assert.equal(verdictAt(tracker, 400).level, 'degrade');
  assert.equal(verdictAt(tracker, 1499).level, 'degrade');
  assert.equal(verdictAt(tracker, 4499).level, 'degrade');
  assert.equal(verdictAt(tracker, RENDER_GIVE_UP_MS * RENDER_GIVE_UP_DEADLINES).level, 'give-up');
});

test('hidden time does not accrue against either deadline', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  tracker.setHidden(true, 100);
  // Thirty seconds of locked phone. The old wall clock read 75 missed deadlines
  // here and gave up on the owner's pattern while he was not looking.
  assert.equal(tracker.awakeElapsed(30_100), 100);
  assert.equal(verdictAt(tracker, 30_100).level, 'ok');
  tracker.setHidden(false, 30_100);
  assert.equal(tracker.awakeElapsed(30_100), 100);
  assert.equal(verdictAt(tracker, 30_100).level, 'ok');
});

test('a resume gets a bounded grace, not an infinite one', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  tracker.setHidden(true, 50);
  tracker.setHidden(false, 20_000);
  // Inside the grace: silent, even though a tick lands immediately on resume.
  assert.equal(verdictAt(tracker, 20_000 + RENDER_RESUME_GRACE_MS - 1).level, 'ok');
  // Past the grace the ordinary awake clock applies again — no free pass.
  assert.equal(verdictAt(tracker, 20_000 + 400).level, 'degrade');
  assert.equal(verdictAt(tracker, 20_000 + RENDER_GIVE_UP_MS * RENDER_GIVE_UP_DEADLINES).level, 'give-up');
});

test('awake time already spent is still owed after a resume', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  // Four seconds of visible waiting, then hidden for a minute, then back.
  tracker.setHidden(true, 4000);
  tracker.setHidden(false, 64_000);
  assert.equal(tracker.awakeElapsed(64_000), 4000);
  // Grace suppresses the first moments, then the banked 4 s counts as 4 s.
  assert.equal(verdictAt(tracker, 64_000 + 10).level, 'ok');
  assert.equal(verdictAt(tracker, 64_000 + RENDER_RESUME_GRACE_MS + 1).level, 'degrade');
  assert.equal(verdictAt(tracker, 64_000 + 600).level, 'give-up');
});

test('a render posted while the page is already hidden starts stopped', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0, hidden: true });
  assert.equal(tracker.hidden, true);
  assert.equal(tracker.awakeElapsed(10_000), 0);
  assert.equal(verdictAt(tracker, 10_000).level, 'ok');
  tracker.setHidden(false, 10_000);
  assert.equal(tracker.awakeElapsed(10_000), 0);
});

test('repeated locks cannot extend the grace into forever', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  tracker.setHidden(true, 10);
  tracker.setHidden(false, 5000);
  // Hide and show again inside the grace window.
  tracker.setHidden(true, 5100);
  tracker.setHidden(false, 9000);
  // The grace restarts, but it is measured in awake ms and the banked awake time
  // (10 + 100 = 110 ms) is untouched, so a second lock buys nothing but 250 ms.
  assert.equal(tracker.awakeElapsed(9000), 110);
  assert.equal(verdictAt(tracker, 9000 + RENDER_RESUME_GRACE_MS + 1).level, 'ok');
  assert.equal(verdictAt(tracker, 9000 + 400).level, 'degrade');
});

test('setHidden is idempotent and reports whether it changed anything', () => {
  const tracker = createRenderDeadlineTracker({ startedAt: 0 });
  assert.equal(tracker.setHidden(false, 100), false);
  assert.equal(tracker.awakeElapsed(100), 100);
  assert.equal(tracker.setHidden(true, 100), true);
  assert.equal(tracker.setHidden(true, 900), false);
  assert.equal(tracker.awakeElapsed(900), 100);
});

test('missed counts the destructive window, not the degrade window', () => {
  assert.equal(classifyRenderDeadline({ awakeElapsed: 1400 }).missed, 0);
  assert.equal(classifyRenderDeadline({ awakeElapsed: 3200 }).missed, 2);
  assert.equal(classifyRenderDeadline({ awakeElapsed: 4600 }).missed, 3);
  assert.equal(classifyRenderDeadline({ awakeElapsed: 4600 }).level, 'give-up');
  assert.equal(classifyRenderDeadline({ awakeElapsed: 4600, hidden: true }).level, 'ok');
});
