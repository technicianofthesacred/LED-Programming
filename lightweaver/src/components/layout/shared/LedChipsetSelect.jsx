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
      <div className="la-strip-density" role="group" aria-label={groupLabel}>
        {CARD_LED_TYPES.map(type => (
          <button key={type} type="button"
                  className={`btn${selected === type ? ' is-selected' : ''}`}
                  aria-label={`${type} — ${CARD_LED_TYPE_HINTS[type]}`}
                  aria-pressed={selected === type}
                  title={CARD_LED_TYPE_HINTS[type]}
                  data-testid={`led-chipset-${type}`}
                  onClick={() => { if (type !== selected) onChange(type); }}>
            {type}
          </button>
        ))}
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
