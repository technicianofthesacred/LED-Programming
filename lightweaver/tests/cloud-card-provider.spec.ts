import { expect, test, type Page } from '@playwright/test';

async function installCloudCardProviderHarness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    document.body.innerHTML = '<div id="cloud-card-provider-root"></div>';

    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const { cardProjectFingerprint } = await import('/src/lib/cardProjectResolver.js');
    const { CloudLibraryProvider, useCloudLibrary } = await import('/src/state/CloudLibraryContext.jsx');
    const { ProjectProvider, useProject } = await import('/src/state/ProjectContext.jsx');

    const targetDocument = createDefaultProject();
    targetDocument.id = 'lwproj-card-target';
    targetDocument.name = 'Card target';
    targetDocument.layout.starterPending = false;

    const sourceDocument = createDefaultProject();
    sourceDocument.id = 'lwproj-cloud-source';
    sourceDocument.name = 'Cloud source';
    sourceDocument.layout.starterPending = false;

    const makeRemote = (id, document) => ({
      id,
      embeddedProjectId: document.id,
      title: document.name,
      archived: false,
      revision: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      createdBy: 'worker@example.test',
      lastEditor: 'worker@example.test',
      document,
    });
    const metadata = remote => ({
      id: remote.id,
      embeddedProjectId: remote.embeddedProjectId,
      title: remote.title,
      archived: remote.archived,
      revision: remote.revision,
      createdAt: remote.createdAt,
      updatedAt: remote.updatedAt,
      createdBy: remote.createdBy,
      lastEditor: remote.lastEditor,
    });
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };

    const target = makeRemote('remote-card-target', targetDocument);
    const source = makeRemote('remote-cloud-source', sourceDocument);
    const state = {
      api: null,
      remotes: new Map([[target.id, target], [source.id, source]]),
      target,
      source,
      evidence: {
        cardId: 'lw-aabbccddeeff',
        projectId: targetDocument.id,
        projectRevision: target.revision,
        projectFingerprint: cardProjectFingerprint(targetDocument),
      },
      calls: [],
      updateCalls: [],
      logoutCalls: 0,
      holdLogout: false,
      logoutGate: deferred(),
      logoutPromise: null,
      logoutTriggered: false,
      lastResult: null,
    };

    const client = {
      getAccountSession: async () => ({
        username: 'worker',
        email: 'worker@example.test',
        displayName: 'Worker',
        role: 'customer',
        mustChangePassword: false,
      }),
      getSession: async () => ({ email: 'worker@example.test', role: 'customer' }),
      listProjects: async ({ state: projectState }) => {
        state.calls.push(`list:${projectState}`);
        return [...state.remotes.values()]
          .filter(remote => projectState === (remote.archived ? 'archived' : 'active'))
          .map(metadata);
      },
      readProject: async (id) => {
        state.calls.push(`read:${id}`);
        const remote = state.remotes.get(id);
        if (!remote) throw Object.assign(new Error('Project not found.'), { status: 404 });
        return remote;
      },
      updateProject: async (id, body, options) => {
        state.calls.push(`update:${id}`);
        state.updateCalls.push({ id, body: structuredClone(body), options: structuredClone(options) });
        const current = state.remotes.get(id);
        if (!current) throw Object.assign(new Error('Project not found.'), { status: 404 });
        const updated = {
          ...current,
          embeddedProjectId: body.project.id,
          title: body.title,
          revision: current.revision + 1,
          updatedAt: '2026-08-01T01:00:00.000Z',
          document: structuredClone(body.project),
        };
        state.remotes.set(id, updated);
        if (id === state.source.id) state.source = updated;
        if (id === state.target.id) state.target = updated;
        return updated;
      },
      logout: async () => {
        state.logoutCalls += 1;
        if (state.holdLogout) await state.logoutGate.promise;
      },
    };

    function Harness() {
      const library = useCloudLibrary();
      const project = useProject();
      state.api = { library, project };
      return React.createElement('div', null,
        React.createElement('span', { 'data-testid': 'provider-session' }, library.session.status),
        React.createElement('span', { 'data-testid': 'provider-project-id' }, project.projectId),
        React.createElement('span', { 'data-testid': 'provider-active-remote' }, library.activeRemoteProject?.id || ''),
        React.createElement('span', { 'data-testid': 'provider-active-count' }, String(library.activeProjects.length)),
        React.createElement('span', { 'data-testid': 'provider-browser-count' }, String(library.browserProjects.length)),
      );
    }

    const root = createRoot(document.getElementById('cloud-card-provider-root'));
    root.render(React.createElement(ProjectProvider, null,
      React.createElement(CloudLibraryProvider, { client }, React.createElement(Harness))));
    window.__LW_CLOUD_CARD_PROVIDER__ = state;
  });

  await expect(page.getByTestId('provider-session')).toHaveText('authenticated');
  await expect(page.getByTestId('provider-active-count')).toHaveText('2');
}

test('browser project list refreshes when another tab changes library storage', async ({ page }) => {
  await installCloudCardProviderHarness(page);
  await expect(page.getByTestId('provider-browser-count')).toHaveText('0');

  await page.evaluate(() => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    const project = structuredClone(state.source.document);
    project.id = 'lwproj-cross-tab-browser';
    project.name = 'Cross-tab browser project';
    const record = {
      id: 'browser-cross-tab-record',
      name: project.name,
      createdAt: 1,
      updatedAt: 1,
      projectVersion: project.version,
      project,
    };
    localStorage.setItem('lw_project_library_v1', JSON.stringify({ version: 1, records: [record] }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'lw_project_library_v1' }));
  });

  await expect(page.getByTestId('provider-browser-count')).toHaveText('1');
});

test('saveNow acknowledges only the exact remote and workspace marker', async ({ page }) => {
  await installCloudCardProviderHarness(page);

  const opened = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    return state.api.library.openProject(state.source.id, { force: true });
  });
  expect(opened).toMatchObject({ ok: true, project: { id: 'remote-cloud-source' } });
  await expect(page.getByTestId('provider-active-remote')).toHaveText('remote-cloud-source');

  await page.evaluate(() => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.api.project.setProjectName('Cloud source edited');
  });
  await expect.poll(() => page.evaluate(() => {
    const lifecycle = (window as any).__LW_CLOUD_CARD_PROVIDER__.api.project.projectLifecycle;
    return lifecycle.editedRevision;
  })).toBeGreaterThan(0);

  const result = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    const lifecycle = state.api.project.projectLifecycle;
    const marker = { generation: lifecycle.generation, revision: lifecycle.editedRevision };
    const wrongRemote = await state.api.library.saveNow({
      expectedRemoteId: 'remote-other',
      expectedMarker: marker,
    });
    const wrongMarker = await state.api.library.saveNow({
      expectedRemoteId: state.source.id,
      expectedMarker: { ...marker, revision: marker.revision + 1 },
    });
    const exact = await state.api.library.saveNow({
      expectedRemoteId: state.source.id,
      expectedMarker: marker,
    });
    return { wrongRemote, wrongMarker, exact, marker, updateCalls: state.updateCalls };
  });

  expect(result.wrongRemote).toEqual({ ok: false, reason: 'workspace-changed' });
  expect(result.wrongMarker).toEqual({ ok: false, reason: 'workspace-changed' });
  expect(result.exact).toMatchObject({ ok: true, project: { id: 'remote-cloud-source', revision: 2 } });
  expect(result.updateCalls).toHaveLength(1);
  expect(result.updateCalls[0]).toMatchObject({
    id: 'remote-cloud-source',
    body: { baseRevision: 1, title: 'Cloud source edited' },
  });
  await expect.poll(() => page.evaluate(() => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    return {
      remoteId: state.api.library.activeRemoteProject?.id,
      remoteRevision: state.api.library.activeRemoteProject?.revision,
      persistence: state.api.project.projectLifecycle.persistence,
    };
  })).toEqual({
    remoteId: 'remote-cloud-source',
    remoteRevision: 2,
    persistence: { destination: 'cloud', revision: result.marker.revision },
  });
});

test('openMatchingCardProject re-reads active, archived, and revision state before replacement', async ({ page }) => {
  await installCloudCardProviderHarness(page);
  const originalProjectId = await page.getByTestId('provider-project-id').textContent();

  const archivedResult = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.calls = [];
    state.target.archived = true;
    return {
      result: await state.api.library.openMatchingCardProject(
        state.target.id,
        state.evidence,
        { expectedRevision: 1, currentProjectSaved: true },
      ),
      calls: state.calls,
    };
  });

  expect(archivedResult.result).toEqual({ ok: false, reason: 'card-project-mismatch' });
  expect(archivedResult.calls).toEqual(expect.arrayContaining([
    'list:active',
    'list:archived',
    'read:remote-card-target',
  ]));
  await expect(page.getByTestId('provider-project-id')).toHaveText(originalProjectId!);
});

test('openMatchingCardProject rejects a fresh revision mismatch without replacing', async ({ page }) => {
  await installCloudCardProviderHarness(page);
  const originalProjectId = await page.getByTestId('provider-project-id').textContent();

  const revisionResult = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.calls = [];
    state.target.revision = 2;
    return {
      result: await state.api.library.openMatchingCardProject(
        state.target.id,
        state.evidence,
        { expectedRevision: 1, currentProjectSaved: true },
      ),
      calls: state.calls,
    };
  });

  expect(revisionResult.result).toEqual({ ok: false, reason: 'card-project-mismatch' });
  expect(revisionResult.calls).toEqual(expect.arrayContaining([
    'list:active',
    'list:archived',
    'read:remote-card-target',
  ]));
  await expect(page.getByTestId('provider-project-id')).toHaveText(originalProjectId!);
});

test('a session epoch change after replacement reports the committed replacement and clears association', async ({ page }) => {
  await installCloudCardProviderHarness(page);
  const opened = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    return state.api.library.openProject(state.source.id, { force: true });
  });
  expect(opened).toMatchObject({ ok: true });
  await expect(page.getByTestId('provider-active-remote')).toHaveText('remote-cloud-source');

  const result = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.holdLogout = true;
    const activePatternId = state.target.document.pattern.activePatternId;
    Object.defineProperty(state.target.document.pattern, 'activePatternId', {
      configurable: true,
      enumerable: true,
      get() {
        if (!state.logoutTriggered) {
          state.logoutTriggered = true;
          queueMicrotask(() => queueMicrotask(() => {
            state.logoutPromise = state.api.library.logout();
          }));
        }
        return activePatternId;
      },
    });
    return state.api.library.openMatchingCardProject(
      state.target.id,
      state.evidence,
      { expectedRevision: 1, currentProjectSaved: true },
    );
  });

  expect(result).toMatchObject({
    ok: false,
    reason: 'stale-session',
    replacementCommitted: true,
    project: { id: 'remote-card-target' },
  });
  await expect(page.getByTestId('provider-project-id')).toHaveText('lwproj-card-target');
  await expect(page.getByTestId('provider-active-remote')).toHaveText('');

  await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.logoutGate.resolve();
    await state.logoutPromise;
  });
  await expect(page.getByTestId('provider-session')).toHaveText('unauthenticated');
});

test('a card precondition change before mutation prevents replacement', async ({ page }) => {
  await installCloudCardProviderHarness(page);
  const originalProjectId = await page.getByTestId('provider-project-id').textContent();

  const result = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    return state.api.library.openMatchingCardProject(
      state.target.id,
      state.evidence,
      {
        expectedRevision: 1,
        currentProjectSaved: true,
        beforeMutation: () => { throw new Error('Card session changed.'); },
      },
    );
  });

  expect(result).toEqual({ ok: false, reason: 'precondition-changed' });
  await expect(page.getByTestId('provider-project-id')).toHaveText(originalProjectId!);
  await expect(page.getByTestId('provider-active-remote')).toHaveText('');
});

test('a session epoch change before mutation prevents replacement', async ({ page }) => {
  await installCloudCardProviderHarness(page);
  const originalProjectId = await page.getByTestId('provider-project-id').textContent();

  const result = await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.holdLogout = true;
    return state.api.library.openMatchingCardProject(
      state.target.id,
      state.evidence,
      {
        expectedRevision: 1,
        currentProjectSaved: true,
        beforeMutation: () => {
          state.logoutPromise = state.api.library.logout();
        },
      },
    );
  });

  expect(result).toEqual({ ok: false, reason: 'superseded' });
  await expect(page.getByTestId('provider-project-id')).toHaveText(originalProjectId!);
  await expect(page.getByTestId('provider-active-remote')).toHaveText('');

  await page.evaluate(async () => {
    const state = (window as any).__LW_CLOUD_CARD_PROVIDER__;
    state.logoutGate.resolve();
    await state.logoutPromise;
  });
});
