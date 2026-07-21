import { expect, test } from '@playwright/test';

test('accepted staging is rolled back when the physical test unmounts before its await resumes', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/');

  await page.evaluate(async () => {
    document.body.innerHTML = '<div id="production-physical-unmount-root"></div>';
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { ProductionPhysicalTest } = await import('/src/components/production/ProductionPhysicalTest.jsx');
    const { createProductionKnownGood } = await import('/src/lib/productionPhysicalTest.js');

    const index = await fetch('/production/jobs/index.json').then(response => response.json());
    const job = await fetch(index.jobs[0].url).then(response => response.json());
    const snapshot = createProductionKnownGood(job);
    const cardId = 'lw-aabbccddeeff';
    const cardLink = {
      state: 'connected-bridge', transport: 'bridge', host: '192.168.18.70',
      card: { id: cardId }, expectedCard: { id: cardId }, cardBlank: false,
      validatedBootId: 'boot-production-unmount-1', operationGeneration: 4, bridgeLifecycle: 9,
      readiness: {
        app: 'Lightweaver', cardId,
        firmwareVersion: job.firmware.version, buildId: job.firmware.buildId,
        bootId: 'boot-production-unmount-1', runtimePhase: 'ready',
        knownGoodProject: true, commandReady: true, outputReady: true,
      },
    };
    const exactEvidence = {
      app: 'Lightweaver', cardId,
      firmwareVersion: job.firmware.version, buildId: job.firmware.buildId,
      projectRevision: job.project.revision, projectFingerprint: job.project.fingerprint,
      productionJobId: job.jobId, productionJobDigest: job.digest,
    };
    const knownGoodStatus = () => ({
      ...exactEvidence, state: 'known-good',
      colorOrder: snapshot.config.led.colorOrder,
      maxMilliamps: snapshot.config.led.maxMilliamps,
      wiringRevision: snapshot.wiringRevision,
      wiringDigest: snapshot.wiringDigest,
      outputs: snapshot.config.led.outputs,
    });
    const stats = { stage: 0, rollback: 0, activate: 0, frames: 0 };
    let resolveStage: ((value: object) => void) | null = null;
    window.__LW_PRODUCTION_DRIVER_FOR_TEST__ = {
      getCardLink: () => cardLink,
      readEvidence: async () => exactEvidence,
      readWiringStatus: async () => knownGoodStatus(),
      startPhysical: async ({ generation }) => {
        stats.frames += 1;
        return { ok: true, generation };
      },
      stageCandidate: async () => {
        stats.stage += 1;
        return new Promise(resolve => { resolveStage = resolve; });
      },
      activateCandidate: async activationId => {
        stats.activate += 1;
        return { state: 'testing', activationId };
      },
      rollbackCandidate: async activationId => {
        stats.rollback += 1;
        return { state: 'rolled-back', activationId };
      },
    };
    window.__LW_UNMOUNT_TEST__ = { stats, resolveStage: value => resolveStage?.(value) };

    const root = createRoot(document.getElementById('production-physical-unmount-root'));
    root.render(React.createElement(ProductionPhysicalTest, {
      job, runId: 'run_production_unmount_1234', cardLink, expectedCardId: cardId,
      platform: { os: 'linux', arch: 'x86_64' },
    }));
    window.__LW_UNMOUNT_ROOT__ = root;
  });

  await expect(page.getByText('Test delivered to this exact boundary. Look at the real LEDs — this is not a pass.')).toBeVisible();
  await page.getByRole('button', { name: 'Red end is off' }).click();
  await page.getByRole('button', { name: 'Adjust pixel count safely' }).click();
  await page.getByRole('button', { name: '+ 1 pixel' }).click();
  await expect.poll(() => page.evaluate(() => window.__LW_UNMOUNT_TEST__.stats.stage)).toBe(1);

  await page.evaluate(() => {
    window.__LW_UNMOUNT_TEST__.resolveStage({ state: 'staged', activationId: 'candidate-unmount-1' });
    window.__LW_UNMOUNT_ROOT__.unmount();
  });

  await expect.poll(() => page.evaluate(() => window.__LW_UNMOUNT_TEST__.stats.rollback)).toBe(1);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__LW_UNMOUNT_TEST__.stats)).toEqual({
    stage: 1, rollback: 1, activate: 0, frames: 1,
  });
  expect(consoleErrors).toEqual([]);
});
