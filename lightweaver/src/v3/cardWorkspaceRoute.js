// Guided setup is a section OF the card workspace, not a screen beside it.
// The two were peers in the rail and asked the same questions — which port,
// which colour order, how many LEDs, install it — in two different idioms.
// Setup is now the workspace's front door and the tabs behind it are the
// same hardware surfaces, reached without leaving the card.
// The FALLBACK section stays `overview`. Setup is the front door, but it is
// reached by naming it — the rail, #screen=setup, or the first-run bootstrap —
// never by a hash that merely forgot to say which section it wanted. Making it
// the fallback meant any stray re-canonicalization of the URL swapped the
// status board out from under an in-flight card operation and cancelled it.
export const DEFAULT_CARD_SECTION = 'overview';
export const FIRST_RUN_CARD_SECTION = 'setup';
const CARD_SECTION_KEYS = new Set(['setup', 'overview', 'install', 'settings', 'workshop', 'support', 'preferences']);

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
  // #screen=setup was its own rail destination before the merge. Every link,
  // bookmark and printed handoff card carrying it still lands on the ladder.
  if (screen === 'setup') return { section: 'setup', supportTool: '' };
  const section = params.get('section');
  return { section: CARD_SECTION_KEYS.has(section) ? section : DEFAULT_CARD_SECTION, supportTool: '' };
}

export function isCardSection(section) {
  return CARD_SECTION_KEYS.has(section);
}

// In-app card navigation intent: set by the shell when the user actively
// navigates to a Card section, consumed once by CardScreen so it can focus
// the section heading on arrival WITHOUT stealing focus on a direct page
// load (the difference between a11y and a race).
let pendingSectionFocus = false;
export function markCardSectionNavigation() { pendingSectionFocus = true; }
export function consumeCardSectionNavigation() {
  const value = pendingSectionFocus;
  pendingSectionFocus = false;
  return value;
}
