import '../../styles/lw-ui.css';

// Plain-language state read to assistive tech (no WAITING/COMPLETE jargon —
// redesign change 3). The visible rail conveys the same states by segment
// color plus the checkmark glyph on done steps.
const STATE_TEXT = {
  done: 'done',
  current: 'current step',
  todo: 'not ready yet',
  optional: 'optional',
};

/**
 * StepRail — slim horizontal progress rail.
 * steps: [{ id, label, state: 'done' | 'current' | 'todo' | 'optional' }]
 * Each step is a real button (segment bar + label stacked) so the rail is
 * keyboard focusable; the open step gets aria-current="step" and the
 * .lwui-rail-active accent ring. Each button's accessible name carries the
 * step state ("Wires — done") so completion is not color-only.
 * Done segments fill --ok, the current segment fills --accent, the rest
 * stay --border. Done labels get a checkmark glyph — no status pills.
 */
export function StepRail({ steps = [], activeId, onSelect }) {
  return (
    <div className="lwui-rail" role="group" aria-label="Steps">
      {steps.map((step) => {
        const state = step.state || 'todo';
        const isActive = step.id === activeId;
        return (
          <button
            key={step.id}
            type="button"
            className={`lwui-rail-step lwui-rail-${state}${
              isActive ? ' lwui-rail-active' : ''
            }`}
            aria-current={isActive ? 'step' : undefined}
            aria-label={`${step.label} — ${STATE_TEXT[state] || STATE_TEXT.todo}`}
            onClick={onSelect ? () => onSelect(step.id) : undefined}
          >
            <span className="lwui-rail-seg" aria-hidden="true" />
            <span className="lwui-rail-label">
              {step.label}
              {state === 'done' && (
                <span className="lwui-rail-check" aria-hidden="true">
                  {' '}
                  ✓
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default StepRail;
