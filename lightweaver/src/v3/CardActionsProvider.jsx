// Card actions, mounted once at the Shell: the shared service behind every
// screen-level card operation that used to be duplicated or prop-drilled.
//
//   adoptCardProject  — the guarded adoption machine (lib/cardProjectAdoption)
//                       bound to the app-level save barrier, association, and
//                       verification handlers. Screens supply only their UI
//                       seams (report/openPatterns/flight refs) per call.
//   recoverLights     — lib/cardRecoverLights.recoverCardLightsVerified.
//   importProjectFile — lib/projectImportFile mechanics with the app's
//                       replaceProject; callers keep their own cleanup.
//   openCard          — the footer's openCardControl routing (Connected →
//                       control drawer; needs attention → exact Setup task;
//                       otherwise → Connection Center).
//
// The provider mounts unconditionally above the screen switch and its value
// is memoized, so its identity never changes across renders — this codebase
// has remount-reset-guard history (see THINKING.md 2026-08-07), and a
// conditional provider would reset every consumer's state below it. Fresh
// app-level values are read through a ref at call time instead of re-creating
// the callbacks.
//
// CardOverview (lw-card.jsx) deliberately keeps binding the adoption machine
// from its own props rather than this context: tests/card-workspace.spec.ts
// renders CardScreen standalone with harness-injected handlers, and that
// prop contract is the proof the machine is exercised against. The provider
// exists for screens that never received the handlers as props (Setup).
import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { guardedResolutionRun } from '../lib/cardProjectAdoption.js';
import { readCardProjectEvidence, readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { loadProductionJobFromIndexEntry, loadProductionJobIndex } from '../lib/productionJobPackage.js';
import { readCardPatternsFromCard, readCardZonesFromCard } from '../lib/cardLiveControl.js';
import { recoverCardLightsVerified } from '../lib/cardRecoverLights.js';
import { importProjectFromFile } from '../lib/projectImportFile.js';
import { getCardLinkState, isCardLinkConnected } from '../lib/cardLink.js';
import { clearAbandonedCardEditIntent, readCardEditIntent } from '../lib/cardEditIntent.js';
import {
  clearCardEditAuthorization,
  issueCardEditAuthorization,
  issueSignedProductionCardEditAuthorization,
} from '../lib/cardEditAuthorization.js';

const CardActionsContext = createContext(null);

export function useCardActions() {
  return useContext(CardActionsContext);
}

export function CardActionsProvider({ deps, children }) {
  // Always-fresh app values without ever changing callback identity.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const adoptCardProject = useCallback(async (options = {}) => {
    const app = depsRef.current;
    const {
      report = () => {},
      openPatterns = () => { window.location.hash = '#screen=pattern'; },
      flight = null,
      requestProbe = () => {},
      applyCardParts = null,
      replaceProject = null,
      ...params
    } = options;
    const cardLink = app.cardLink;
    return guardedResolutionRun({
      context: {
        ready: isCardLinkConnected(cardLink),
        cardLink,
        cardHost: app.cardHost,
        currentProject: app.serializeProject(),
        projectGeneration: app.projectGeneration,
        activeCloudProjects: app.activeCloudProjects,
        browserProjects: app.browserProjects,
      },
      getLatestContext: () => {
        const latest = depsRef.current;
        return {
          ready: isCardLinkConnected(latest.cardLink),
          cardLink: latest.cardLink,
          currentProject: latest.serializeProject(),
          projectGeneration: latest.projectGeneration,
          browserProjects: latest.browserProjects,
        };
      },
      getSharedCardLink: getCardLinkState,
      isCardLinkConnected,
      io: {
        readCardProjectEvidence,
        readCardStatusEnvelope,
        loadProductionJobIndex,
        loadProductionJobFromIndexEntry,
        readCloudProject: app.readCloudProject,
        readBrowserProjects: app.readBrowserProjects,
        readCardPatternsFromCard,
        readCardZonesFromCard,
      },
      actions: {
        replaceProject: replaceProject || app.replaceProject,
        saveBeforeCardProjectSwitch: app.saveBeforeCardProjectSwitch,
        isProjectSwitchSnapshotCurrent: app.isProjectSwitchSnapshotCurrent,
        openMatchingCardProject: app.openMatchingCardProject,
        onMatchedProjectLoaded: app.onMatchedProjectLoaded,
        onMatchedProjectVerified: app.onMatchedProjectVerified,
        applyCardParts,
      },
      authorization: {
        clearCardEditAuthorization,
        issueCardEditAuthorization,
        issueSignedProductionCardEditAuthorization,
        clearAbandonedCardEditIntent,
        getCardEditIntent: () => readCardEditIntent(window.location.search),
      },
      ui: { report, openPatterns },
      // A caller that wants cross-call single-flight passes its own ref-like
      // objects; a per-call default keeps one run internally consistent.
      flight: flight || {
        inFlight: { current: false },
        pendingProbe: { current: null },
        probeSignature: { current: '' },
      },
      requestProbe,
    }, params);
  }, []);

  const recoverLights = useCallback(
    (look = {}, options = {}) => recoverCardLightsVerified(look, options),
    [],
  );

  const importProjectFile = useCallback(
    (file, replaceProject = null) => importProjectFromFile(file, replaceProject || depsRef.current.replaceProject),
    [],
  );

  const openCard = useCallback(() => depsRef.current.openCardControl?.(), []);

  const value = useMemo(
    () => ({ adoptCardProject, recoverLights, importProjectFile, openCard }),
    [adoptCardProject, recoverLights, importProjectFile, openCard],
  );
  return <CardActionsContext.Provider value={value}>{children}</CardActionsContext.Provider>;
}
