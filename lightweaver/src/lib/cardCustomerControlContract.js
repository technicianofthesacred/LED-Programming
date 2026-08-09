export const CUSTOMER_CONTROL_WIRE_FIELDS = Object.freeze([
  Object.freeze({ control: 'patternId', wire: 'patternId', acknowledgement: 'appliedPatternId' }),
  Object.freeze({ control: 'brightness', wire: 'brightness', acknowledgement: 'brightness' }),
  Object.freeze({ control: 'speed', wire: 'speed', acknowledgement: 'speed' }),
  Object.freeze({ control: 'hueShift', wire: 'hueShift', acknowledgement: 'hueShift' }),
  Object.freeze({ control: 'blackout', wire: 'blackout', acknowledgement: 'blackout' }),
  Object.freeze({ control: 'customHue', wire: 'hue', acknowledgement: 'hue' }),
  Object.freeze({ control: 'customSaturation', wire: 'saturation', acknowledgement: 'saturation' }),
  Object.freeze({ control: 'customBreathe', wire: 'breathe', acknowledgement: 'breathe' }),
  Object.freeze({ control: 'breatheLowerPct', wire: 'breatheLowerPct', acknowledgement: 'breatheLowerPct' }),
  Object.freeze({ control: 'breatheUpperPct', wire: 'breatheUpperPct', acknowledgement: 'breatheUpperPct' }),
  Object.freeze({ control: 'breatheCycleSeconds', wire: 'breatheCycleSeconds', acknowledgement: 'breatheCycleSeconds' }),
  Object.freeze({ control: 'customDrift', wire: 'drift', acknowledgement: 'drift' }),
  Object.freeze({ control: 'driftHueMin', wire: 'driftMin', acknowledgement: 'driftMin' }),
  Object.freeze({ control: 'driftHueMax', wire: 'driftMax', acknowledgement: 'driftMax' }),
]);

export function cardEditIntentForPattern(pattern = {}) {
  const key = pattern.mode === 'combo' ? 'editLook' : 'editPattern';
  const installedId = String(pattern.id || '').trim();
  const id = String(key === 'editLook'
    ? (installedId.startsWith('combo-') ? installedId.slice('combo-'.length) : installedId)
    : pattern.runtimePatternId || '').trim();
  return id ? { key, id } : null;
}
