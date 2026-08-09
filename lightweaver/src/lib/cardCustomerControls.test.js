import assert from 'node:assert/strict';
import {
  applyCustomerControlAcknowledgement,
  beginCustomerControl,
  createCardCustomerControls,
  normalizeCardCustomerControls,
} from './cardCustomerControls.js';

const initial = normalizeCardCustomerControls({
  zones: [{
    id: 'all',
    label: 'Whole piece',
    patternId: 'aurora',
    brightness: 0.7,
    speed: 1.2,
    hueShift: -8,
    customHue: 42,
    customSaturation: 200,
    customBreathe: false,
    customDrift: false,
    driftHueMin: 17,
    driftHueMax: 203,
    blackout: false,
  }],
}, {
  currentId: 'aurora',
  patterns: [{ id: 'aurora', label: 'Aurora', mode: 'procedural' }, { id: 'ocean', label: 'Ocean', mode: 'combo' }],
});

assert.equal(initial.activePatternId, 'aurora');
assert.deepEqual(initial.patterns.map(pattern => pattern.id), ['aurora', 'ocean']);
assert.equal(initial.look.brightness, 0.7);
assert.equal(initial.look.driftHueMin, 17, 'the card-confirmed drift lower bound survives normalization');
assert.equal(initial.look.driftHueMax, 203, 'the card-confirmed drift upper bound survives normalization');
assert.equal(initial.patterns[0].mode, 'procedural', 'pattern mode survives for exact advanced-edit routing');
assert.equal(initial.patterns[1].mode, 'combo', 'combo look mode survives for editLook routing');

const state = createCardCustomerControls(initial);
const pending = beginCustomerControl(state, { brightness: 0.4 });
assert.equal(pending.view.look.brightness, 0.4, 'the pending look is immediately visible');
assert.equal(pending.confirmed.look.brightness, 0.7, 'the last confirmed look is retained for rollback');

const failed = applyCustomerControlAcknowledgement(pending, pending.command.id, new Error('offline'));
assert.equal(failed.view.look.brightness, 0.7, 'a failed control restores the confirmed look');
assert.equal(failed.failure?.message, 'offline');
assert.deepEqual(failed.retry, { brightness: 0.4 }, 'the rejected customer intent remains retryable');

const missingAppliedPending = beginCustomerControl(state, { brightness: 0.4 });
const missingAppliedValue = applyCustomerControlAcknowledgement(
  missingAppliedPending,
  missingAppliedPending.command.id,
  { ok: true, patternId: 'aurora' },
);
assert.equal(missingAppliedValue.view.look.brightness, 0.7, 'pattern-only acknowledgements cannot confirm a brightness change');
assert.match(missingAppliedValue.failure?.message || '', /confirm/i);

const separateSession = beginCustomerControl(createCardCustomerControls(initial), { speed: 1.4 });
assert.notEqual(separateSession.command.id, pending.command.id, 'close and reopen cannot reuse a command correlation');

const first = beginCustomerControl(state, { brightness: 0.4 });
const second = beginCustomerControl(first, { brightness: 0.9 });
const stale = applyCustomerControlAcknowledgement(second, first.command.id, { ok: true, brightness: 0.4 });
assert.equal(stale.view.look.brightness, 0.9, 'a late acknowledgement cannot overwrite newer intent');
const confirmed = applyCustomerControlAcknowledgement(stale, second.command.id, { ok: true, brightness: 0.85 });
assert.equal(confirmed.view.look.brightness, 0.85, 'an acknowledgement becomes the next confirmed look');
assert.equal(confirmed.view.look.driftHueMin, 17, 'unrelated acknowledgements preserve the confirmed drift palette');
assert.equal(confirmed.view.look.driftHueMax, 203, 'unrelated acknowledgements preserve the confirmed drift palette');
assert.equal(confirmed.pending, null);

assert.throws(
  () => normalizeCardCustomerControls({ zones: Array(40).fill({ id: 'x' }) }, { patterns: Array(80).fill({ id: 'x' }) }),
  /malformed/i,
  'unbounded card data is rejected rather than rendered',
);
