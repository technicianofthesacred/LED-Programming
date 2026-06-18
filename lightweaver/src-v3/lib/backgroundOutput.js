const BACKGROUND_OUTPUT_SCREENS = new Set(['layout', 'devices', 'export', 'flash', 'settings']);

export function shouldRunBackgroundPatternOutput(screen) {
  return BACKGROUND_OUTPUT_SCREENS.has(String(screen || ''));
}
