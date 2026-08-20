import { cardTaskCopy } from './cardTaskCopy.js';

// The Connect panel's structural loop-breaker (card-interaction
// consolidation, phase 5). The panel owns transport mechanics ONLY —
// triage, direct probe, pair/adopt/take-over, Bridge launch and return
// codes, setup-network steps, the manual host form. Any verdict whose
// remedy is owned by the card lifecycle renders from THIS table instead:
// one short line and ONE button that closes the panel and continues on
// Card Home. The panel has no other branch for these action ids, so it
// structurally cannot re-diagnose — the historic Setup↔Center ping-pong
// (each surface's only exit reopening the other) has no path left.
//
// `line` is the single route-out sentence ('' keeps the verdict's own
// explanation). `destination` is what the panel's executor does after
// closing:
//   'setup-task'        → the shell's onOpenSetup (Card Home, at the task
//                         the derived setup journey names — the authority
//                         decides, not this panel)
//   'recover-operation' → openCardFlow('recover-operation') (Card Home's
//                         recover task, pinned — the journey cannot name it
//                         from a link the panel already failed to read)
export const CONNECT_PANEL_ROUTE_OUT = Object.freeze({
  // Every LIFECYCLE_OWNED state (recovering, updating, update-recovering,
  // update-rolled-back, target-mismatch, project-changed, project-mismatch,
  // attention-required) collapses to this one action id in the authority.
  'lifecycle-attention': Object.freeze({
    line: '',
    label: 'Continue in Setup',
    destination: 'setup-task',
  }),
  // A blank connected card is a project question, not a connection one.
  // Strip discovery and install-project live on Card Home.
  'card-needs-project': Object.freeze({
    line: 'Connected — this card has no project. Set one up from Card Home.',
    label: 'Continue on Card Home',
    destination: 'setup-task',
  }),
  // An uncertain write/recovery outcome is a lifecycle question; the panel
  // no longer offers its own recovery body (USB install or Bridge launch).
  'needs-safe-recovery': Object.freeze({
    line: cardTaskCopy('recover-operation'),
    label: 'Continue on Card Home',
    destination: 'recover-operation',
  }),
});

export function connectPanelRouteOut(actionId) {
  return CONNECT_PANEL_ROUTE_OUT[actionId] || null;
}
