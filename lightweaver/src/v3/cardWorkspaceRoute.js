const CARD_SECTION_KEYS = new Set(['overview', 'install', 'settings', 'workshop', 'support', 'preferences']);

export function cardRouteFromHash(hash = globalThis.location?.hash || '') {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  const screen = String(params.get('screen') || '').toLowerCase();
  if (screen === 'flash') {
    return params.get('mode') === 'install'
      ? { section: 'install', supportTool: '' }
      : { section: 'support', supportTool: 'technician' };
  }
  if (screen === 'installer') return { section: 'support', supportTool: 'guide' };
  if (screen === 'production') return { section: 'workshop', supportTool: '' };
  if (screen === 'settings') return { section: 'preferences', supportTool: '' };
  const section = params.get('section');
  return { section: CARD_SECTION_KEYS.has(section) ? section : 'overview', supportTool: '' };
}

export function isCardSection(section) {
  return CARD_SECTION_KEYS.has(section);
}
