import { expect, test, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleLibraryRequest } from '../functions/api/library/_shared/router.js';
import { createDefaultProject } from '../src/lib/projectModel.js';

type Role = 'owner' | 'worker' | null;
type PortableProject = ReturnType<typeof createDefaultProject>;

type Revision = {
  revision: number;
  archived: boolean;
  createdAt: string;
  editor: string;
  document: PortableProject;
};

type StoredProject = {
  id: string;
  title: string;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  lastEditor: string;
  document: PortableProject;
  revisions: Revision[];
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  });
}

async function fulfillResponse(route: Route, response: Response) {
  return route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  });
}

function metadata(project: StoredProject) {
  return {
    id: project.id,
    embeddedProjectId: project.document.id,
    title: project.title,
    archived: project.archived,
    revision: project.revision,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    createdBy: project.createdBy,
    lastEditor: project.lastEditor,
  };
}

function portable(name: string, id = `lwproj-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`) {
  const project = createDefaultProject();
  project.id = id;
  project.name = name;
  return project;
}

class LibraryFixture {
  role: Role;
  email: string;
  projects = new Map<string, StoredProject>();
  nextId = 1;
  delayNextUpdate = false;
  delayedUpdateStarted: Promise<void> | null = null;
  private signalDelayedUpdateStarted: (() => void) | null = null;
  private delayedUpdateGate: Promise<void> | null = null;
  private releaseDelayedUpdate: (() => void) | null = null;
  forceNextConflict = false;
  updateFailures: number[] = [];
  updateRequestIds: string[] = [];
  updateCount = 0;
  loseNextUpdateResponse = false;
  acceptedUpdateRequestIds = new Set<string>();
  signInNavigations: string[] = [];
  delayNextCreate = false;
  delayedCreateStarted: Promise<void> | null = null;
  private signalDelayedCreateStarted: (() => void) | null = null;
  private delayedCreateGate: Promise<void> | null = null;
  private releaseDelayedCreate: (() => void) | null = null;
  delayedReadStarted: Promise<void> | null = null;
  private delayedReadId = '';
  private signalDelayedReadStarted: (() => void) | null = null;
  private delayedReadGate: Promise<void> | null = null;
  private releaseDelayedRead: (() => void) | null = null;

  constructor(role: Role = 'worker', email = role === 'owner' ? 'owner@example.test' : 'worker@example.test') {
    this.role = role;
    this.email = email;
  }

  seed(title: string, options: { archived?: boolean; revisions?: PortableProject[] } = {}) {
    const id = `remote-${this.nextId++}`;
    const documents = options.revisions || [portable(title)];
    const createdAt = '2026-08-01T01:00:00.000Z';
    const revisions = documents.map((document, index) => ({
      revision: index + 1,
      archived: options.archived === true,
      createdAt: `2026-08-01T0${index + 1}:00:00.000Z`,
      editor: this.email,
      document: structuredClone(document),
    }));
    const document = structuredClone(documents.at(-1)!);
    const project: StoredProject = {
      id,
      title,
      archived: options.archived === true,
      revision: revisions.length,
      createdAt,
      updatedAt: revisions.at(-1)!.createdAt,
      createdBy: this.email,
      lastEditor: this.email,
      document,
      revisions,
    };
    this.projects.set(id, project);
    return project;
  }

  holdNextUpdate() {
    this.delayNextUpdate = true;
    this.delayedUpdateStarted = new Promise(resolve => { this.signalDelayedUpdateStarted = resolve; });
    this.delayedUpdateGate = new Promise<void>(resolve => { this.releaseDelayedUpdate = resolve; });
  }

  releaseUpdate() {
    this.releaseDelayedUpdate?.();
    this.releaseDelayedUpdate = null;
  }

  holdNextCreate() {
    this.delayNextCreate = true;
    this.delayedCreateStarted = new Promise(resolve => { this.signalDelayedCreateStarted = resolve; });
    this.delayedCreateGate = new Promise<void>(resolve => { this.releaseDelayedCreate = resolve; });
  }

  releaseCreate() {
    this.releaseDelayedCreate?.();
    this.releaseDelayedCreate = null;
  }

  holdRead(id: string) {
    this.delayedReadId = id;
    this.delayedReadStarted = new Promise(resolve => { this.signalDelayedReadStarted = resolve; });
    this.delayedReadGate = new Promise<void>(resolve => { this.releaseDelayedRead = resolve; });
  }

  releaseRead() {
    this.releaseDelayedRead?.();
    this.releaseDelayedRead = null;
  }

  async install(page: Page) {
    await page.route('**/api/library/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const segments = url.pathname.slice('/api/library/'.length).split('/').filter(Boolean);
      const method = request.method();

      if (segments[0] === 'login' && method === 'GET' && request.isNavigationRequest()) {
        const returnTo = url.searchParams.get('returnTo') || '/';
        this.signInNavigations.push(returnTo);
        // This transition represents Cloudflare Access completing before the
        // protected Function runs. Redirect semantics come from the real router.
        this.role = 'worker';
        const response = await handleLibraryRequest({
          request: new Request(request.url()),
          identity: { email: this.email, role: this.role, subject: 'fixture-access-subject' },
          store: null,
        });
        await fulfillResponse(route, response);
        return;
      }

      if (!this.role) {
        await json(route, { error: { code: 'unauthenticated', message: 'Authentication is required.', requestId: 'fixture-401' } }, 401);
        return;
      }
      if (segments[0] === 'session' && method === 'GET') {
        await json(route, { session: { email: this.email, role: this.role } });
        return;
      }
      if (segments[0] === 'projects' && segments.length === 1 && method === 'GET') {
        const archived = url.searchParams.get('state') === 'archived';
        await json(route, { projects: [...this.projects.values()].filter(item => item.archived === archived).map(metadata) });
        return;
      }
      if (segments[0] === 'projects' && segments.length === 1 && method === 'POST') {
        const body = request.postDataJSON();
        if (this.delayNextCreate) {
          this.delayNextCreate = false;
          this.signalDelayedCreateStarted?.();
          await this.delayedCreateGate;
        }
        const project = this.seed(body.title, { revisions: [body.project] });
        await json(route, { project: metadata(project) }, 201);
        return;
      }
      if (segments[0] === 'projects' && segments.length === 2) {
        const project = this.projects.get(segments[1]);
        if (!project) {
          await json(route, { error: { code: 'not_found', message: 'Project not found.', requestId: 'fixture-404' } }, 404);
          return;
        }
        if (method === 'GET') {
          if (this.delayedReadId === project.id) {
            this.delayedReadId = '';
            this.signalDelayedReadStarted?.();
            await this.delayedReadGate;
          }
          await json(route, { project: { ...metadata(project), document: structuredClone(project.document) } });
          return;
        }
        if (method === 'DELETE') {
          if (this.role !== 'owner') {
            await json(route, { error: { code: 'forbidden', message: 'Only the owner may delete projects.', requestId: 'fixture-403' } }, 403);
            return;
          }
          this.projects.delete(project.id);
          await json(route, { deleted: true });
          return;
        }
        if (method === 'PUT') {
          this.updateCount += 1;
          const updateRequestId = request.headers()['x-lightweaver-request'] || '';
          this.updateRequestIds.push(updateRequestId);
          const body = request.postDataJSON();
          if (this.acceptedUpdateRequestIds.has(updateRequestId)) {
            await json(route, { error: { code: 'idempotency_conflict', message: 'The idempotency key was already accepted.', requestId: 'fixture-idempotency' } }, 409);
            return;
          }
          const failure = this.updateFailures.shift();
          if (failure) {
            await json(route, { error: { code: `fixture_${failure}`, message: `Fixture failure ${failure}.`, requestId: `fixture-${failure}` } }, failure);
            return;
          }
          if (this.forceNextConflict) {
            this.forceNextConflict = false;
            project.revision += 1;
            project.title = 'Latest online version';
            project.document = portable('Latest online version', project.document.id);
            project.updatedAt = '2026-08-01T08:00:00.000Z';
            project.revisions.push({
              revision: project.revision,
              archived: project.archived,
              createdAt: project.updatedAt,
              editor: 'other-worker@example.test',
              document: structuredClone(project.document),
            });
            await json(route, { error: { code: 'revision_conflict', message: 'The project changed online.', requestId: 'fixture-409' } }, 409);
            return;
          }
          if (body.baseRevision !== project.revision) {
            await json(route, { error: { code: 'revision_conflict', message: 'The project changed online.', requestId: 'fixture-stale' } }, 409);
            return;
          }
          if (this.delayNextUpdate) {
            this.delayNextUpdate = false;
            this.signalDelayedUpdateStarted?.();
            await this.delayedUpdateGate;
            if (body.baseRevision !== project.revision) {
              await json(route, { error: { code: 'revision_conflict', message: 'The project changed online.', requestId: 'fixture-delayed-stale' } }, 409);
              return;
            }
          }
          project.revision += 1;
          project.title = body.title ?? project.title;
          project.document = structuredClone(body.project);
          project.updatedAt = `2026-08-01T${String(project.revision).padStart(2, '0')}:00:00.000Z`;
          project.lastEditor = this.email;
          project.revisions.push({
            revision: project.revision,
            archived: project.archived,
            createdAt: project.updatedAt,
            editor: this.email,
            document: structuredClone(project.document),
          });
          this.acceptedUpdateRequestIds.add(updateRequestId);
          if (this.loseNextUpdateResponse) {
            this.loseNextUpdateResponse = false;
            await route.abort('failed');
            return;
          }
          await json(route, { project: metadata(project) });
          return;
        }
      }

      const project = this.projects.get(segments[1]);
      if (segments[0] === 'projects' && project && segments[2] === 'duplicate' && method === 'POST') {
        const body = request.postDataJSON();
        const title = body.title || `${project.title} Copy`;
        const duplicate = this.seed(title, { revisions: [{ ...structuredClone(project.document), id: `lwproj-copy-${this.nextId}`, name: title }] });
        await json(route, { project: metadata(duplicate) }, 201);
        return;
      }
      if (segments[0] === 'projects' && project && ['archive', 'unarchive'].includes(segments[2]) && method === 'POST') {
        project.archived = segments[2] === 'archive';
        project.revision += 1;
        project.updatedAt = `2026-08-01T${String(project.revision).padStart(2, '0')}:30:00.000Z`;
        project.revisions.push({
          revision: project.revision,
          archived: project.archived,
          createdAt: project.updatedAt,
          editor: this.email,
          document: structuredClone(project.document),
        });
        await json(route, { project: metadata(project) });
        return;
      }
      if (segments[0] === 'projects' && project && segments[2] === 'revisions' && segments.length === 3 && method === 'GET') {
        await json(route, { revisions: project.revisions.slice().reverse().map(item => ({
          revision: item.revision,
          archived: item.archived,
          createdAt: item.createdAt,
          editor: item.editor,
        })) });
        return;
      }
      if (segments[0] === 'projects' && project && segments[2] === 'revisions' && segments[4] === 'restore' && method === 'POST') {
        const source = project.revisions.find(item => item.revision === Number(segments[3]));
        project.revision += 1;
        project.document = structuredClone(source!.document);
        project.updatedAt = `2026-08-01T${String(project.revision).padStart(2, '0')}:45:00.000Z`;
        project.revisions.push({
          revision: project.revision,
          archived: project.archived,
          createdAt: project.updatedAt,
          editor: this.email,
          document: structuredClone(project.document),
        });
        await json(route, { project: metadata(project) });
        return;
      }
      if (segments[0] === 'backup' && method === 'GET') {
        await json(route, {
          format: 'lightweaver.library-backup',
          version: 1,
          exportedAt: '2026-08-01T09:00:00.000Z',
          projects: [...this.projects.values()].map(item => ({
            id: item.id,
            title: item.title,
            archived: item.archived,
            currentRevision: item.revision,
            revisions: item.revisions.map(revision => ({
              revision: revision.revision,
              archived: revision.archived,
              createdAt: revision.createdAt,
              document: revision.document,
            })),
          })),
          workspaceAssets: [],
        });
        return;
      }
      if (segments[0] === 'restore' && method === 'POST') {
        const backup = request.postDataJSON();
        for (const item of backup.projects || []) {
          const source = item.revisions.find((revision: any) => revision.revision === item.currentRevision);
          this.seed(`${item.title} (restored)`, { archived: item.archived, revisions: [source.document] });
        }
        await json(route, { summary: { projectsCreated: backup.projects?.length || 0, assetsCreated: backup.workspaceAssets?.length || 0 } });
        return;
      }
      await json(route, { error: { code: 'not_found', message: 'Fixture route not found.', requestId: 'fixture-route' } }, 404);
    });
  }
}

async function openLibrary(page: Page) {
  await page.goto('/#screen=card&section=preferences', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('project-library-panel')).toBeVisible();
}

test('signs in with a top-level Access navigation and returns to the Studio', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await fixture.install(page);
  await openLibrary(page);
  await expect(page.getByText('Sign in to use the online project library')).toBeVisible();

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('worker@example.test')).toBeVisible();
  await expect(page.getByText('Worker', { exact: true })).toBeVisible();
  expect(fixture.signInNavigations).toEqual(['/#screen=card&section=preferences']);
});

test('turns a remembered remote revision divergence into an explicit conflict without overwriting either side', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const original = portable('Original recovery', 'lwproj-divergence');
  const latest = portable('Latest remote', 'lwproj-divergence');
  const remote = fixture.seed('Latest remote', { revisions: [original, latest] });
  await page.addInitScript(({ local, remoteId }) => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(local));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(local));
    localStorage.setItem('lw_cloud_active_project_v1', JSON.stringify({ id: remoteId, revision: 1 }));
  }, { local: original, remoteId: remote.id });
  await fixture.install(page);
  await openLibrary(page);

  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Online conflict');
  await expect(page.getByRole('button', { name: 'Open latest' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save as copy' })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(fixture.updateCount).toBe(0);
  expect([...fixture.projects.values()][0].document.name).toBe('Latest remote');
  await page.getByRole('button', { name: 'Save as copy' }).click();
  await expect(page.getByTestId('cloud-project-row').getByText('Original recovery copy', { exact: true })).toBeVisible();
  expect([...fixture.projects.values()].some(project => project.document.name === 'Latest remote')).toBe(true);
  expect([...fixture.projects.values()].some(project => project.document.name === 'Original recovery copy')).toBe(true);
});

test('creates a named online project and reports only acknowledged revisions as saved', async ({ page, context }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await openLibrary(page);

  await page.getByLabel('Online project title').fill('Gallery Bloom');
  await page.getByRole('button', { name: 'Create online project' }).click();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect(page.getByTestId('cloud-project-row').getByText('Gallery Bloom', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_cloud_active_project_v1') || 'null')))
    .toEqual({ id: [...fixture.projects.values()][0].id, revision: 1 });

  fixture.holdNextUpdate();
  await page.getByLabel('Project name').fill('Gallery Bloom revised');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saving online');
  await fixture.delayedUpdateStarted;

  await page.getByLabel('Project name').fill('Gallery Bloom final');
  fixture.releaseUpdate();
  await expect(page.getByTestId('cloud-sync-status')).not.toHaveText('Saved online');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  expect([...fixture.projects.values()][0].document.name).toBe('Gallery Bloom final');

  await context.setOffline(true);
  await page.getByLabel('Project name').fill('Gallery Bloom offline');
  await expect(page.getByTestId('cloud-sync-status')).toContainText('Waiting to save online');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}').name)).toBe('Gallery Bloom offline');
  await context.setOffline(false);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

  fixture.holdNextUpdate();
  await page.getByLabel('Project name').fill('Gallery Bloom manual save');
  await expect(page.getByTestId('cloud-sync-status')).toContainText('Waiting to save online');
  await page.getByRole('button', { name: 'Save project' }).click();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saving online');
  fixture.releaseUpdate();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
});

test('create and active rename acknowledge only captured markers and queue newer edits', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await openLibrary(page);

  fixture.holdNextCreate();
  await page.getByLabel('Online project title').fill('Captured create');
  await page.getByRole('button', { name: 'Create online project' }).click();
  await fixture.delayedCreateStarted;
  await page.getByLabel('Project name').fill('Edited while creating');
  fixture.releaseCreate();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  const created = [...fixture.projects.values()][0];
  await expect.poll(() => fixture.projects.get(created.id)?.document.name).toBe('Edited while creating');

  const row = page.getByTestId('cloud-project-row').filter({ hasText: 'Edited while creating' });
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Rename project').fill('Captured rename');
  fixture.holdNextUpdate();
  await page.getByRole('button', { name: 'Save name' }).click();
  await fixture.delayedUpdateStarted;
  await expect(page.getByLabel('Project name')).toHaveValue('Captured rename');
  await page.getByLabel('Project name').fill('Edited while renaming');
  fixture.releaseUpdate();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect.poll(() => fixture.projects.get(created.id)?.document.name).toBe('Edited while renaming');
  expect(fixture.projects.get(created.id)?.title).toBe('Edited while renaming');
});

test('ignores superseded reads and confirms before a late read can replace intervening edits', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const first = fixture.seed('Slow first');
  fixture.seed('Fast second');
  await fixture.install(page);
  await openLibrary(page);

  fixture.holdRead(first.id);
  await page.getByTestId('cloud-project-row').filter({ hasText: 'Slow first' }).getByRole('button', { name: 'Open' }).click();
  await fixture.delayedReadStarted;
  await page.getByTestId('cloud-project-row').filter({ hasText: 'Fast second' }).getByRole('button', { name: 'Open' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Fast second');
  fixture.releaseRead();
  await page.waitForTimeout(200);
  await expect(page.getByLabel('Project name')).toHaveValue('Fast second');

  fixture.holdRead(first.id);
  await page.getByTestId('cloud-project-row').filter({ hasText: 'Slow first' }).getByRole('button', { name: 'Open' }).click();
  await fixture.delayedReadStarted;
  await page.getByLabel('Project name').fill('Intervening local edit');
  fixture.releaseRead();
  const confirmation = page.getByRole('dialog', { name: 'Replace current project?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Intervening local edit');
});

test('retries transient saves with one request ID, waits exactly, and demotes rejected sessions', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Retry project');
  await fixture.install(page);
  await openLibrary(page);
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Open' }).click();

  fixture.updateFailures.push(503);
  await page.getByLabel('Project name').fill('Retry once');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Waiting to save online');
  await expect.poll(() => fixture.updateCount, { timeout: 6000 }).toBe(2);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  expect(fixture.updateRequestIds[0]).toBeTruthy();
  expect(fixture.updateRequestIds[1]).toBe(fixture.updateRequestIds[0]);

  fixture.updateFailures.push(400);
  await page.getByLabel('Project name').fill('Do not retry bad request');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Online save needs attention');
  const requestsAfterBadInput = fixture.updateCount;
  await page.waitForTimeout(2800);
  expect(fixture.updateCount).toBe(requestsAfterBadInput);

  fixture.updateFailures.push(401);
  await page.getByLabel('Project name').fill('Expired identity');
  await expect(page.getByText('Sign in to use the online project library')).toBeVisible();
  await expect(page.getByText('worker@example.test')).toHaveCount(0);
});

test('reconnect replays a committed save with its original request ID and reconciles the lost response', async ({ page, context }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Reconnect project');
  await fixture.install(page);
  await openLibrary(page);
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Open' }).click();

  fixture.loseNextUpdateResponse = true;
  await page.getByLabel('Project name').fill('Recovered after reconnect');
  await expect.poll(() => fixture.updateCount).toBe(1);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Waiting to save online');
  expect(fixture.projects.get(remote.id)?.revision).toBe(2);

  await context.setOffline(true);
  await context.setOffline(false);
  await expect.poll(() => fixture.updateCount).toBe(2);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect(page.getByRole('button', { name: 'Open latest' })).toHaveCount(0);
  expect(fixture.updateRequestIds[1]).toBe(fixture.updateRequestIds[0]);
  expect(fixture.projects.get(remote.id)?.document.name).toBe('Recovered after reconnect');
});

test('same-project rename wins over an in-flight stale replay without creating a false conflict', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Rename retry project');
  fixture.updateFailures.push(503);
  await fixture.install(page);
  await openLibrary(page);
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Open' }).click();

  await page.getByLabel('Project name').fill('Pending before rename');
  await expect.poll(() => fixture.updateCount).toBe(1);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Waiting to save online');

  fixture.holdNextUpdate();
  await fixture.delayedUpdateStarted;
  const row = page.getByTestId('cloud-project-row').filter({ hasText: 'Rename retry project' });
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Rename project').fill('Renamed after transient failure');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect.poll(() => fixture.projects.get(remote.id)?.title).toBe('Renamed after transient failure');
  await page.getByLabel('Project name').fill('Edited while rename completed');
  fixture.releaseUpdate();

  await expect.poll(() => fixture.projects.get(remote.id)?.document.name).toBe('Edited while rename completed');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect(page.getByRole('button', { name: 'Open latest' })).toHaveCount(0);
  expect(fixture.projects.get(remote.id)?.revision).toBe(3);
  expect(fixture.updateCount).toBe(4);
});

test('same-project archive wins over an in-flight stale replay and saves the pending document', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Archive retry project');
  fixture.updateFailures.push(503);
  await fixture.install(page);
  await openLibrary(page);
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Open' }).click();

  await page.getByLabel('Project name').fill('Pending through archive');
  await expect.poll(() => fixture.updateCount).toBe(1);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Waiting to save online');
  fixture.holdNextUpdate();
  await fixture.delayedUpdateStarted;
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Archive' }).click();
  await expect.poll(() => fixture.projects.get(remote.id)?.archived).toBe(true);
  fixture.releaseUpdate();

  await expect.poll(() => fixture.projects.get(remote.id)?.document.name).toBe('Pending through archive');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect(page.getByRole('button', { name: 'Open latest' })).toHaveCount(0);
  expect(fixture.projects.get(remote.id)?.archived).toBe(true);
  expect(fixture.projects.get(remote.id)?.revision).toBe(3);
  expect(fixture.updateCount).toBe(3);
});

test('same-project history restore wins over an in-flight stale replay so later edits can save', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Restore retry project', {
    revisions: [portable('Earlier restore state'), portable('Restore retry project')],
  });
  fixture.updateFailures.push(503);
  await fixture.install(page);
  await openLibrary(page);
  const row = page.getByTestId('cloud-project-row').filter({ hasText: 'Restore retry project' });
  await row.getByRole('button', { name: 'Open' }).click();

  await page.getByLabel('Project name').fill('Pending before restore');
  await expect.poll(() => fixture.updateCount).toBe(1);
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Waiting to save online');
  fixture.holdNextUpdate();
  await fixture.delayedUpdateStarted;
  await row.getByRole('button', { name: 'History' }).click();
  await page.getByTestId('history-revision-1').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Earlier restore state');
  fixture.releaseUpdate();

  await page.getByLabel('Project name').fill('Edited after restore');
  await expect.poll(() => fixture.projects.get(remote.id)?.document.name).toBe('Edited after restore');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect(page.getByRole('button', { name: 'Open latest' })).toHaveCount(0);
  expect(fixture.projects.get(remote.id)?.revision).toBe(4);
  expect(fixture.updateCount).toBe(3);
});

test('demotes a forbidden authenticated session without retrying', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Forbidden project');
  await fixture.install(page);
  await openLibrary(page);
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Open' }).click();
  fixture.updateFailures.push(403);
  await page.getByLabel('Project name').fill('Forbidden edit');
  await expect(page.getByText('The online library is unavailable')).toBeVisible();
  const count = fixture.updateCount;
  await page.waitForTimeout(2800);
  expect(fixture.updateCount).toBe(count);
});

test('cancels a pending transient retry when the cloud provider unmounts', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    document.body.innerHTML = '<div id="cloud-unmount-root"></div>';
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { CloudLibraryError } = await import('/src/lib/cloudLibraryClient.js');
    const { CloudLibraryProvider, useCloudLibrary } = await import('/src/state/CloudLibraryContext.jsx');
    const { ProjectProvider, useProject } = await import('/src/state/ProjectContext.jsx');

    const stats = { updates: 0 };
    let stored = null;
    const client = {
      getSession: async () => ({ email: 'worker@example.test', role: 'worker' }),
      listProjects: async ({ state }) => state === 'active' && stored ? [stored] : [],
      createProject: async ({ title, project }) => {
        stored = {
          id: 'unmount-remote', title, archived: false, revision: 1,
          createdAt: '2026-08-01T01:00:00.000Z', updatedAt: '2026-08-01T01:00:00.000Z',
          createdBy: 'worker@example.test', lastEditor: 'worker@example.test',
          embeddedProjectId: project.id,
        };
        return stored;
      },
      updateProject: async () => {
        stats.updates += 1;
        throw new CloudLibraryError('temporary', 'Temporary failure.', { status: 503 });
      },
    };

    function Harness() {
      const library = useCloudLibrary();
      const { setProjectName } = useProject();
      const started = React.useRef(false);
      React.useEffect(() => {
        if (library.session.status !== 'authenticated' || started.current) return;
        started.current = true;
        void library.createProject('Unmount retry').then(result => {
          if (result.ok) setProjectName('Unmount retry changed');
        });
      }, [library, setProjectName]);
      return React.createElement('div', null, library.syncState.label);
    }

    const root = createRoot(document.getElementById('cloud-unmount-root'));
    root.render(React.createElement(ProjectProvider, null,
      React.createElement(CloudLibraryProvider, { client }, React.createElement(Harness))));
    window.__LW_CLOUD_UNMOUNT__ = { root, stats };
  });

  await expect.poll(() => page.evaluate(() => window.__LW_CLOUD_UNMOUNT__.stats.updates)).toBe(1);
  await page.evaluate(() => window.__LW_CLOUD_UNMOUNT__.root.unmount());
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.__LW_CLOUD_UNMOUNT__.stats.updates)).toBe(1);
});

test('opens, renames, duplicates, archives, restores history, and unarchives projects', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const first = portable('First draft', 'lwproj-history');
  const latest = portable('Current sculpture', 'lwproj-history');
  const seeded = fixture.seed('Current sculpture', { revisions: [first, latest] });
  await fixture.install(page);
  await openLibrary(page);

  const row = page.getByTestId('cloud-project-row').filter({ hasText: 'Current sculpture' });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Current sculpture');
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Rename project').fill('Temple sculpture');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect.poll(() => fixture.projects.get(seeded.id)?.title).toBe('Temple sculpture');
  const renamedRow = page.getByTestId('cloud-project-row').filter({ has: page.getByText('Temple sculpture', { exact: true }) });
  await expect(renamedRow).toHaveCount(1);
  await expect(renamedRow).toContainText('revision 3');
  await expect(page.getByLabel('Project name')).toHaveValue('Temple sculpture');
  expect(fixture.projects.get(seeded.id)?.document.name).toBe('Temple sculpture');

  await page.getByTestId('cloud-project-row').filter({ hasText: 'Temple sculpture' }).getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByText('Temple sculpture Copy', { exact: true })).toBeVisible();
  await page.getByTestId('cloud-project-row').filter({ hasText: 'Temple sculpture' }).first().getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Project history' })).toBeVisible();
  await page.getByTestId('history-revision-1').getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('dialog', { name: 'Project history' })).toHaveCount(0);
  await expect(page.getByLabel('Project name')).toHaveValue('First draft');

  await page.getByTestId('cloud-project-row').filter({ has: page.getByText('Temple sculpture', { exact: true }) }).getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Archived projects' }).click();
  await expect(page.getByTestId('cloud-project-row').getByText('Temple sculpture', { exact: true })).toBeVisible();
  await page.getByTestId('cloud-project-row').filter({ has: page.getByText('Temple sculpture', { exact: true }) }).getByRole('button', { name: 'Unarchive' }).click();
  await page.getByRole('button', { name: 'Active projects' }).click();
  await expect(page.getByTestId('cloud-project-row').getByText('Temple sculpture', { exact: true })).toBeVisible();
});

test('preserves both sides of a conflict with Open latest and Save as copy', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Shared piece');
  await fixture.install(page);
  await openLibrary(page);
  await page.getByTestId('cloud-project-row').getByRole('button', { name: 'Open' }).click();

  fixture.forceNextConflict = true;
  await page.getByLabel('Project name').fill('My unsent version');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Online conflict');
  await page.getByRole('button', { name: 'Open latest' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Latest online version');

  fixture.forceNextConflict = true;
  await page.getByLabel('Project name').fill('Keep this local version');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Online conflict');
  await page.getByRole('button', { name: 'Save as copy' }).click();
  await expect(page.getByTestId('cloud-project-row').getByText('Keep this local version copy', { exact: true })).toBeVisible();
  expect([...fixture.projects.values()].some(project => project.document.name === 'Keep this local version copy')).toBe(true);
  expect([...fixture.projects.values()].some(project => project.document.name === 'Latest online version')).toBe(true);
});

test('never offers worker delete and requires an owner to type an archived project title', async ({ page }) => {
  const worker = new LibraryFixture('worker');
  worker.seed('Archived work', { archived: true });
  await worker.install(page);
  await openLibrary(page);
  await page.getByRole('button', { name: 'Archived projects' }).click();
  await expect(page.getByRole('button', { name: 'Delete permanently' })).toHaveCount(0);

  await page.unroute('**/api/library/**');
  const owner = new LibraryFixture('owner');
  owner.seed('Owner archive', { archived: true });
  await owner.install(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Archived projects' }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete Owner archive permanently?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
  await dialog.getByLabel('Type project title to confirm').fill('Owner archive');
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByText('Owner archive', { exact: true })).toHaveCount(0);
});

test('history and delete dialogs trap focus, close on Escape, isolate the background, and restore focus', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.seed('History focus', { revisions: [portable('Earlier focus'), portable('History focus')] });
  fixture.seed('Delete focus', { archived: true });
  await fixture.install(page);
  await openLibrary(page);
  const studioRoot = page.locator('#root');
  expect(await studioRoot.evaluate(element => ({ aria: element.getAttribute('aria-hidden'), inert: element.inert })))
    .toEqual({ aria: null, inert: false });

  const historyTrigger = page.getByTestId('cloud-project-row').filter({ hasText: 'History focus' }).getByRole('button', { name: 'History' });
  await historyTrigger.focus();
  await historyTrigger.click();
  const historyDialog = page.getByRole('dialog', { name: 'Project history' });
  await expect(historyDialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await expect(page.locator('body > [data-cloud-library-dialog-root]')).toHaveCount(1);
  await expect(studioRoot).toHaveAttribute('aria-hidden', 'true');
  expect(await studioRoot.evaluate(element => element.inert)).toBe(true);
  expect(await historyDialog.evaluate(dialog => !document.getElementById('root')?.contains(dialog))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(historyDialog.getByRole('button', { name: 'Restore' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(historyDialog).toHaveCount(0);
  await expect(historyTrigger).toBeFocused();
  await expect(page.locator('body > [data-cloud-library-dialog-root]')).toHaveCount(0);
  expect(await studioRoot.evaluate(element => ({ aria: element.getAttribute('aria-hidden'), inert: element.inert })))
    .toEqual({ aria: null, inert: false });

  await page.getByRole('button', { name: 'Archived projects' }).click();
  const deleteTrigger = page.getByTestId('cloud-project-row').filter({ hasText: 'Delete focus' }).getByRole('button', { name: 'Delete permanently' });
  await studioRoot.evaluate(element => element.setAttribute('aria-hidden', 'false'));
  await deleteTrigger.focus();
  await deleteTrigger.click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete Delete focus permanently?' });
  await expect(deleteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expect(page.locator('body > [data-cloud-library-dialog-root]')).toHaveCount(1);
  await expect(studioRoot).toHaveAttribute('aria-hidden', 'true');
  expect(await studioRoot.evaluate(element => element.inert)).toBe(true);
  await deleteDialog.getByLabel('Type project title to confirm').fill('Delete focus');
  await deleteDialog.getByRole('button', { name: 'Delete permanently' }).focus();
  await page.keyboard.press('Tab');
  await expect(deleteDialog.getByLabel('Type project title to confirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteDialog).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();
  await expect(page.locator('body > [data-cloud-library-dialog-root]')).toHaveCount(0);
  expect(await studioRoot.evaluate(element => ({ aria: element.getAttribute('aria-hidden'), inert: element.inert })))
    .toEqual({ aria: 'false', inert: false });
});

test('claims browser projects and supports individual and master import/export', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Download me');
  const browserProject = portable('Browser-only piece', 'lwproj-browser-only');
  await page.addInitScript((project) => {
    localStorage.setItem('lw_project_library_v1', JSON.stringify({
      version: 1,
      records: [{
        id: 'browser-record',
        name: project.name,
        createdAt: 1,
        updatedAt: 2,
        projectVersion: project.version,
        project,
      }],
    }));
  }, browserProject);
  await fixture.install(page);
  await openLibrary(page);

  await expect(page.getByText('Browser-only piece', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bring browser projects online' }).click();
  await expect(page.getByText('Browser-only piece', { exact: true })).toBeVisible();
  await expect(page.getByText('1 browser project brought online')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bring browser projects online' })).toHaveCount(0);

  const projectDownload = page.waitForEvent('download');
  await page.getByTestId('cloud-project-row').filter({ hasText: 'Download me' }).getByRole('button', { name: 'Export' }).click();
  expect((await projectDownload).suggestedFilename()).toBe('download-me.lw.json');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-cloud-library-'));
  const individualPath = path.join(temp, 'imported.lw.json');
  fs.writeFileSync(individualPath, JSON.stringify(portable('Imported project')));
  await page.setInputFiles('[data-testid="cloud-project-import"]', individualPath);
  await expect(page.getByText('Imported project', { exact: true })).toBeVisible();

  const masterDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download master backup' }).click();
  expect((await masterDownload).suggestedFilename()).toMatch(/^\d{4}-\d{2}-\d{2}-lightweaver-master\.lw-library\.json$/);

  const restorePath = path.join(temp, 'restore.lw-library.json');
  fs.writeFileSync(restorePath, JSON.stringify({
    format: 'lightweaver.library-backup',
    version: 1,
    exportedAt: '2026-08-01T10:00:00.000Z',
    projects: [{
      id: 'backup-project',
      title: 'Backup project',
      archived: false,
      currentRevision: 1,
      revisions: [{ revision: 1, archived: false, createdAt: '2026-08-01T10:00:00.000Z', document: portable('Backup project') }],
    }],
    workspaceAssets: [],
  }));
  await page.setInputFiles('[data-testid="cloud-master-restore"]', restorePath);
  await expect(page.getByText('Restored 1 project and 0 workspace assets')).toBeVisible();
  await expect(page.getByText('Backup project (restored)', { exact: true })).toBeVisible();

  const oversizedProjectPath = path.join(temp, 'oversized.lw.json');
  fs.writeFileSync(oversizedProjectPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  await page.setInputFiles('[data-testid="cloud-project-import"]', oversizedProjectPath);
  await expect(page.getByText('Project files must be 2 MB or smaller.')).toBeVisible();

  const oversizedBackupPath = path.join(temp, 'oversized.lw-library.json');
  fs.writeFileSync(oversizedBackupPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  await page.setInputFiles('[data-testid="cloud-master-restore"]', oversizedBackupPath);
  await expect(page.getByText('Master backups must be 8 MB or smaller.')).toBeVisible();
});
