import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const componentUrl = new URL('../components/layout/shared/CardPushControl.jsx', import.meta.url);

async function source() {
  return readFile(componentUrl, 'utf8');
}

test('card install preflights wiring state and classifies it before any config mutation', async () => {
  const text = await source();
  assert.match(text, /classifyCardDeploymentResume/);
  assert.match(text, /getCardWiringStatus/);
  const preflight = text.indexOf('getCardWiringStatus({ host: cleanHost })');
  const classify = text.indexOf('classifyCardDeploymentResume(');
  const mutate = text.indexOf('pushConfigToCard(');
  assert.ok(preflight >= 0 && classify > preflight && mutate > classify);
});

test('matching candidates resume in place and conflicts give non-mutating rollback or replace guidance', async () => {
  const text = await source();
  assert.match(text, /resumeAction === 'resume-activation'/);
  assert.match(text, /attempt\.resumeAction === 'resume-physical-test' \|\| attempt\.resumeAction === 'resume-confirmation'/);
  assert.match(text, /candidate-conflict[\s\S]{0,500}roll back[\s\S]{0,200}replace/i);
  assert.match(text, /Nothing (?:was sent|was changed)/);
  assert.match(text, /if \(attempt\.resumeAction !== 'stage-new'\)[\s\S]{0,800}return;/);
});

test('installed state requires combined exact project and readiness readback', async () => {
  const text = await source();
  assert.match(text, /readCardProjectEvidence[\s\S]{0,500}readCardStatusEnvelope/);
  assert.match(text, /correlateCardDeploymentReadinessEvidence\(project, status\)/);
  assert.match(text, /requireReady:\s*true/);
});
