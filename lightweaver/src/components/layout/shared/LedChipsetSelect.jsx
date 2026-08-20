import {
  CARD_LED_TYPES,
  CARD_LED_TYPE_HINTS,
  normalizeCardLedType,
} from '../../../lib/cardHardwareContract.js';

// One chipset per project, not per strip: the card holds a single
// RuntimeConfig.ledType and drives every output with it, and the firmware
// validator accepts only the two entries in CARD_LED_TYPES.
export function LedChipsetSelect({ value, onChange, fallback, groupLabel = 'LED chipset' }) {
  const selected = normalizeCardLedType(value, fallback);
  return (
    <div className="la-led-chipset" data-testid="led-chipset-control">
      <span className="k">Chipset</span>
      {/* A dropdown rather than a segmented pair: the option row carries the
          reel-facing voltage hint, which is what an owner actually matches
          against the print on their strip. */}
      <div className="la-gpio-wrap">
        <select className="la-gpio-select la-chipset-select"
                aria-label={groupLabel}
                data-testid="led-chipset-select"
                value={selected}
                onChange={event => {
                  const next = normalizeCardLedType(event.target.value, selected);
                  if (next !== selected) onChange(next);
                }}>
          {CARD_LED_TYPES.map(type => (
            <option key={type} value={type} data-testid={`led-chipset-${type}`}>
              {type} — {CARD_LED_TYPE_HINTS[type]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Changing the chipset changes the wiring digest the card checks, so the card
// stages the new config and waits for a confirm at the piece instead of
// installing straight away (LightweaverStorage.cpp runtimeConfigJsonChangesWiring).
export function LedChipsetHint() {
  return (
    <span className="la-physical-rule-hint" data-testid="led-chipset-hint">
      Match the chipset printed on your reel. Changing it counts as a wiring
      change — the card stages it and asks you to confirm at the piece before
      it installs.
    </span>
  );
}
