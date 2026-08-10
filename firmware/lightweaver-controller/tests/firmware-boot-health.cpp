#include <cassert>

#include "../src/LightweaverFirmwareBootHealth.h"

using lightweaver::FirmwareBootDecision;
using lightweaver::FirmwareBootEvidenceDecision;
using lightweaver::FirmwareBootHealthFacts;
using lightweaver::FirmwareBootHandoffOutcome;
using lightweaver::evaluateFirmwareBootHandoffEvidence;
using lightweaver::evaluateFirmwareBootHealth;

FirmwareBootHealthFacts healthy() {
  FirmwareBootHealthFacts facts{};
  facts.pendingVerification = true;
  facts.compiledIdentityMatches = true;
  facts.nvsReadable = true;
  facts.projectStorageReadable = true;
  facts.savedConfigReadable = true;
  facts.projectHeadReadable = true;
  facts.rendererReady = true;
  facts.controlsReady = true;
  facts.webReady = true;
  facts.watchdogReady = true;
  facts.outputReady = true;
  facts.recoveryReady = true;
  facts.withinDeadline = true;
  return facts;
}

int main() {
  auto facts = healthy();
  facts.routerReachable = false;
  facts.mdnsReady = false;
  facts.browserConnected = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::MarkValid);

  facts = healthy(); facts.nvsReadable = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.projectHeadReadable = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.compiledIdentityMatches = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.rendererReady = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.controlsReady = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.webReady = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.watchdogReady = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.outputReady = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);
  facts = healthy(); facts.withinDeadline = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::Rollback);

  facts = healthy(); facts.pendingVerification = false;
  assert(evaluateFirmwareBootHealth(facts).decision == FirmwareBootDecision::NotPending);

  // A health-check-triggered rollback seals RollbackRequested before reboot.
  // The old slot must surface that record even though it is no longer pending.
  assert(evaluateFirmwareBootHandoffEvidence(
      true, FirmwareBootHandoffOutcome::RollbackRequested, false) ==
      FirmwareBootEvidenceDecision::RolledBack);
  assert(evaluateFirmwareBootHandoffEvidence(
      true, FirmwareBootHandoffOutcome::Armed, false) ==
      FirmwareBootEvidenceDecision::RolledBack);
  assert(evaluateFirmwareBootHandoffEvidence(
      true, FirmwareBootHandoffOutcome::Valid, true) ==
      FirmwareBootEvidenceDecision::Valid);
  assert(evaluateFirmwareBootHandoffEvidence(
      false, FirmwareBootHandoffOutcome::RollbackRequested, false) ==
      FirmwareBootEvidenceDecision::None);
  return 0;
}
