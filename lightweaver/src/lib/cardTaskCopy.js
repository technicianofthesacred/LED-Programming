// One copy table for the guided-setup task ids (setupJourney.SETUP_TASK_IDS).
// These one-line descriptions were duplicated on the card overview; any
// surface describing "the exact next Setup task" imports this instead of
// keeping its own strings. Screens with genuinely different, site-specific
// task wording (the Setup ladder's own button labels and blocker notes in
// lw-setup.jsx) deliberately keep their local strings — this table only owns
// the strings that were byte-identical.
export const CARD_TASK_COPY = Object.freeze({
  'connect-card': 'Connect the exact Lightweaver card.',
  'pair-card': 'Pair the card Studio found.',
  'reconnect-card': 'Reconnect the expected Lightweaver card.',
  'recover-operation': 'Recover the unfinished card operation safely.',
  'update-firmware': 'Update this card before setup continues.',
  'configure-wifi': 'Finish connecting this card to Wi-Fi.',
  'install-project': 'Install the current project on this exact card.',
  'discover-lights': 'Find and count the connected lights.',
  'place-lights': 'Place the discovered lights on the artwork.',
  'verify-direction': 'Verify the physical direction of each strip.',
  'test-and-save': 'Test and save the project to the card.',
  'confirm-visible-lights': 'Confirm what the installed lights show.',
  'load-matching-project': 'Load the saved project that matches this card.',
  'open-patterns': 'Setup is complete. Continue to your patterns.',
});

export function cardTaskCopy(taskId) {
  return CARD_TASK_COPY[taskId] || 'Continue the exact next Setup task.';
}
