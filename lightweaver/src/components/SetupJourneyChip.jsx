import React, { useEffect, useMemo, useState } from 'react';
import { SETUP_PHASE_IDS, deriveSetupJourney } from '../lib/setupJourney.js';
import { cardTaskCopy } from '../lib/cardTaskCopy.js';
import { CARD_COMMISSIONING_CHANGED_EVENT, inspectCardCommissioning } from '../lib/cardCommissioningFlow.js';
import { openCardFlow } from '../lib/cardFlowEntry.js';

// The one setup reminder a working screen (Patterns, Playlist) is allowed to
// carry. It replaced the 6-step JOURNEY_STEPS hint, which was a second journey
// vocabulary competing with the real one: the derived setup journey
// (lib/setupJourney.js) has exactly four owner phases, and this chip renders
// nothing at all once that journey reports completion — a finished owner
// never sees setup words again on a working screen.
//
// One line, one action: the chip names the current phase and the exact next
// task (the same copy table Card Home uses), and clicking it runs
// openCardFlow('fix'), which routes to that task's own surface.
export function SetupJourneyChip({ cardLink, cardLifecycle, project }) {
  // Commissioning state lives in storage, not props; re-read it when the flow
  // announces a change so the chip's phase tracks an in-flight commissioning.
  const [commissioningTick, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump(tick => tick + 1);
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);
  const journey = useMemo(() => deriveSetupJourney({
    cardLink,
    cardLifecycle,
    commissioningFlow: inspectCardCommissioning().flow,
    project,
  }), [cardLink, cardLifecycle, commissioningTick, project]);
  if (journey.setupComplete) return null;
  const phaseNumber = Math.max(1, SETUP_PHASE_IDS.indexOf(journey.currentPhaseId) + 1);
  return (
    <button
      type="button"
      className="setup-journey-chip"
      data-testid="setup-journey-chip"
      onClick={() => openCardFlow('fix', { lifecycle: cardLifecycle, journey })}
    >
      Setup: phase {phaseNumber} of {SETUP_PHASE_IDS.length} — {cardTaskCopy(journey.taskId)}
    </button>
  );
}

export default SetupJourneyChip;
