export const BOARD_CONTROL_FIELDS = Object.freeze([
  { key: 'encoderA', label: 'Encoder A', path: ['encoder', 'a'], allowOff: false },
  { key: 'encoderB', label: 'Encoder B', path: ['encoder', 'b'], allowOff: false },
  { key: 'encoderPress', label: 'Encoder press', path: ['encoder', 'press'], allowOff: true },
  { key: 'encoderAlternatePress', label: 'Alternate press', path: ['encoder', 'alternatePress'], allowOff: true },
  { key: 'previous', label: 'Previous', path: ['previous'], allowOff: true },
  { key: 'next', label: 'Next', path: ['next'], allowOff: true },
  { key: 'blackout', label: 'Blackout', path: ['blackout'], allowOff: true },
  { key: 'brightness', label: 'Dimmer pot', path: ['brightness'], allowOff: true },
  { key: 'statusLed', label: 'Status LED', path: ['statusLed'], allowOff: true },
]);

const clone = value => JSON.parse(JSON.stringify(value || {}));
const fieldByKey = key => BOARD_CONTROL_FIELDS.find(field => field.key === key);
const readPath = (value, path) => path.reduce((cursor, part) => cursor?.[part], value);
const writePath = (value, path, next) => {
  let cursor = value;
  for (const part of path.slice(0, -1)) cursor = cursor[part] ||= {};
  cursor[path.at(-1)] = next;
};

export function activeBoardGpios(outputs = [], controls = {}) {
  return [
    ...outputs.map(output => ({ owner: `output:${output.id}`, pin: Number(output.pin) })),
    ...BOARD_CONTROL_FIELDS.map(field => ({ owner: `control:${field.key}`, pin: Number(readPath(controls, field.path)) })),
  ].filter(item => Number.isInteger(item.pin) && item.pin >= 0);
}

export function planBoardGpioAssignment({ outputs = [], controls = {}, target, pin, supportedOutputPins = [] } = {}) {
  const nextPin = Number(pin);
  const nextOutputs = clone(outputs);
  const nextControls = clone(controls);
  if (!Number.isInteger(nextPin)) return { ok: false, error: 'Choose a whole GPIO number.' };
  let owner;
  if (target?.kind === 'output') {
    const output = nextOutputs.find(item => item.id === target.id);
    if (!output) return { ok: false, error: 'That output no longer exists.' };
    if (!supportedOutputPins.includes(nextPin)) return { ok: false, error: `GPIO ${nextPin} cannot drive an LED output.` };
    output.pin = nextPin;
    owner = `output:${target.id}`;
  } else if (target?.kind === 'control') {
    const field = fieldByKey(target.key);
    if (!field) return { ok: false, error: 'That board control no longer exists.' };
    if (nextPin < (field.allowOff ? -1 : 0) || nextPin > 48) return { ok: false, error: `${field.label} must use GPIO 0–48${field.allowOff ? ' or Off' : ''}.` };
    writePath(nextControls, field.path, nextPin);
    owner = `control:${target.key}`;
  } else return { ok: false, error: 'Choose an output or board control.' };
  const conflict = activeBoardGpios(nextOutputs, nextControls).find(item => item.owner !== owner && item.pin === nextPin && nextPin >= 0);
  if (conflict) return { ok: false, error: `GPIO ${nextPin} is already assigned.` };
  return { ok: true, outputs: nextOutputs, controls: nextControls, error: '' };
}
