import { expect, test, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  async install(page: Page) {
    await page.route('**/api/library/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const segments = url.pathname.slice('/api/library/'.length).split('/').filter(Boolean);
      const method = request.method();

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
          const body = request.postDataJSON();
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

test('guides signed-out users and identifies authenticated workers', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await fixture.install(page);
  await openLibrary(page);
  await expect(page.getByText('Sign in to use the online project library')).toBeVisible();

  fixture.role = 'worker';
  await page.getByRole('button', { name: 'Retry sign in' }).click();
  await expect(page.getByText('worker@example.test')).toBeVisible();
  await expect(page.getByText('Worker', { exact: true })).toBeVisible();
});

test('creates a named online project and reports only acknowledged revisions as saved', async ({ page, context }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await openLibrary(page);

  await page.getByLabel('Online project title').fill('Gallery Bloom');
  await page.getByRole('button', { name: 'Create online project' }).click();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await expect(page.getByTestId('cloud-project-row').getByText('Gallery Bloom', { exact: true })).toBeVisible();

  fixture.holdNextUpdate();
  await page.getByLabel('Project name').fill('Gallery Bloom revised');
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saving online');
  await expect.poll(() => fixture.delayedUpdateStarted).not.toBeNull();

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

test('opens, renames, duplicates, archives, restores history, and unarchives projects', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const first = portable('First draft', 'lwproj-history');
  const latest = portable('Current sculpture', 'lwproj-history');
  fixture.seed('Current sculpture', { revisions: [first, latest] });
  await fixture.install(page);
  await openLibrary(page);

  const row = page.getByTestId('cloud-project-row').filter({ hasText: 'Current sculpture' });
  await row.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Current sculpture');
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Rename project').fill('Temple sculpture');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByText('Temple sculpture', { exact: true })).toBeVisible();

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
});
