import { expect, test, type Browser, type Page, type Route } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleLibraryRequest } from '../functions/api/library/_shared/router.js';
import { createDefaultProject } from '../src/lib/projectModel.js';

type Role = 'owner' | 'worker' | 'customer' | null;
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
  draftOfProjectId?: string;
  draftOwnerAccountId?: string;
  officialTitle?: string;
};

type StoredAsset = {
  kind: string;
  revision: number;
  value: Record<string, any>;
  revisions: Array<{
    revision: number;
    createdAt: string;
    editor: string;
    value: Record<string, any>;
  }>;
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
    ...(project.draftOfProjectId ? {
      draftOfProjectId: project.draftOfProjectId,
      draftOwnerAccountId: project.draftOwnerAccountId,
      officialTitle: project.officialTitle,
    } : {}),
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
  username: string | null;
  accounts = new Map<string, {
    id: string;
    username: string;
    displayName: string;
    role: Exclude<Role, null>;
    status: 'active' | 'disabled';
    mustChangePassword: boolean;
    password: string;
    createdAt: string;
    updatedAt: string;
  }>();
  projects = new Map<string, StoredProject>();
  assignments = new Map<string, Set<string>>();
  assets = new Map<string, StoredAsset>();
  nextId = 1;
  delayNextUpdate = false;
  delayedUpdateStarted: Promise<void> | null = null;
  private signalDelayedUpdateStarted: (() => void) | null = null;
  private delayedUpdateGate: Promise<void> | null = null;
  private releaseDelayedUpdate: (() => void) | null = null;
  forceNextConflict = false;
  projectReadFailures: number[] = [];
  updateFailures: number[] = [];
  updateRequestIds: string[] = [];
  updateCount = 0;
  assetWriteCount = 0;
  assetRequestCount = 0;
  promotionBodies: Array<{ officialBaseRevision: number; draftBaseRevision: number }> = [];
  assetWriteFailures: number[] = [];
  assetReadFailures: number[] = [];
  assetWriteRequestIds: string[] = [];
  acceptedAssetRequests = new Map<string, { kind: string; value: Record<string, any> }>();
  loseNextAssetWriteResponse = false;
  private delayedAssetWriteGate: Promise<void> | null = null;
  private releaseDelayedAssetWrite: (() => void) | null = null;
  delayedAssetWriteStarted: Promise<void> | null = null;
  private signalDelayedAssetWriteStarted: (() => void) | null = null;
  private delayedAssetSuccessGate: Promise<void> | null = null;
  private releaseDelayedAssetSuccess: (() => void) | null = null;
  delayedAssetSuccessStarted: Promise<void> | null = null;
  private signalDelayedAssetSuccessStarted: (() => void) | null = null;
  private heldAssetReadsRemaining = 0;
  private delayedAssetReadGate: Promise<void> | null = null;
  private releaseDelayedAssetReads: (() => void) | null = null;
  delayedAssetReadsStarted: Promise<void> | null = null;
  private signalDelayedAssetReadsStarted: (() => void) | null = null;
  loseNextUpdateResponse = false;
  acceptedUpdateRequestIds = new Set<string>();
  signInNavigations: string[] = [];
  sessionProbeFailures = 0;
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
    const initialRole = role || 'worker';
    const username = email.split('@')[0];
    this.username = role ? username : null;
    this.accounts.set(username, {
      id: `account-${username}`,
      username,
      displayName: email,
      role: initialRole,
      status: 'active',
      mustChangePassword: false,
      password: 'temporary-password',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
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

  addAccount(username: string, role: 'owner' | 'worker' | 'customer', options: { displayName?: string; status?: 'active' | 'disabled'; password?: string; mustChangePassword?: boolean } = {}) {
    const account = {
      id: `account-${username}`,
      username,
      displayName: options.displayName || `${username} display`,
      role,
      status: options.status || 'active',
      mustChangePassword: options.mustChangePassword ?? true,
      password: options.password || 'temporary-password',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as const;
    this.accounts.set(username, { ...account });
    return this.accounts.get(username)!;
  }

  assignCustomer(username: string, official: StoredProject) {
    const customer = this.accounts.get(username)!;
    const draft = this.seed(official.title, { revisions: [structuredClone(official.document)] });
    draft.draftOfProjectId = official.id;
    draft.draftOwnerAccountId = customer.id;
    draft.officialTitle = official.title;
    const assigned = this.assignments.get(customer.id) || new Set<string>();
    assigned.add(official.id);
    this.assignments.set(customer.id, assigned);
    return draft;
  }

  seedAsset(kind: string, value: Record<string, any>) {
    const current = this.assets.get(kind);
    const revision = (current?.revision || 0) + 1;
    const stored = {
      kind,
      revision,
      value: structuredClone(value),
      revisions: [
        ...(current?.revisions || []),
        {
          revision,
          createdAt: `2026-08-01T${String(revision).padStart(2, '0')}:15:00.000Z`,
          editor: 'other-worker@example.test',
          value: structuredClone(value),
        },
      ],
    };
    this.assets.set(kind, stored);
    return stored;
  }

  assetResponse(asset: StoredAsset) {
    const head = asset.revisions.at(-1)!;
    return {
      kind: asset.kind,
      revision: asset.revision,
      hash: `fixture-${asset.kind}-${asset.revision}`,
      bytes: JSON.stringify(asset.value).length,
      updatedAt: head.createdAt,
      lastEditor: head.editor,
      value: structuredClone(asset.value),
    };
  }

  holdNextAssetWrite() {
    this.delayedAssetWriteStarted = new Promise(resolve => { this.signalDelayedAssetWriteStarted = resolve; });
    this.delayedAssetWriteGate = new Promise<void>(resolve => { this.releaseDelayedAssetWrite = resolve; });
  }

  releaseAssetWrite() {
    this.releaseDelayedAssetWrite?.();
    this.releaseDelayedAssetWrite = null;
  }

  holdNextAssetSuccessResponse() {
    this.delayedAssetSuccessStarted = new Promise(resolve => { this.signalDelayedAssetSuccessStarted = resolve; });
    this.delayedAssetSuccessGate = new Promise<void>(resolve => { this.releaseDelayedAssetSuccess = resolve; });
  }

  releaseAssetSuccessResponse() {
    this.releaseDelayedAssetSuccess?.();
    this.releaseDelayedAssetSuccess = null;
  }

  holdNextAssetLoad() {
    this.heldAssetReadsRemaining = 2;
    this.delayedAssetReadsStarted = new Promise(resolve => { this.signalDelayedAssetReadsStarted = resolve; });
    this.delayedAssetReadGate = new Promise<void>(resolve => { this.releaseDelayedAssetReads = resolve; });
  }

  releaseAssetReads() {
    this.releaseDelayedAssetReads?.();
    this.releaseDelayedAssetReads = null;
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
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/account/')) {
        const accountPath = url.pathname.slice('/api/account/'.length);
        const method = request.method();
        if (accountPath === 'session' && method === 'GET') {
          const account = this.username ? this.accounts.get(this.username) : null;
          if (!account || account.status !== 'active') {
            await json(route, { error: { code: 'unauthenticated', message: 'Authentication is required.' } }, 401);
            return;
          }
          await json(route, { session: {
            username: account.username,
            displayName: account.displayName,
            role: account.role,
            mustChangePassword: account.mustChangePassword,
          } });
          return;
        }
        if (accountPath === 'login' && method === 'POST') {
          const body = request.postDataJSON();
          const account = this.accounts.get(String(body.username || '').toLowerCase());
          if (!account || account.status !== 'active' || account.password !== body.password) {
            await json(route, { error: { code: 'invalid_credentials', message: 'Invalid username or password.' } }, 401);
            return;
          }
          this.username = account.username;
          this.role = account.role;
          this.email = account.displayName;
          await json(route, { session: {
            username: account.username,
            displayName: account.displayName,
            role: account.role,
            mustChangePassword: account.mustChangePassword,
          } });
          return;
        }
        if (accountPath === 'password' && method === 'POST') {
          const account = this.username ? this.accounts.get(this.username) : null;
          if (!account) {
            await json(route, { error: { code: 'unauthenticated', message: 'Authentication is required.' } }, 401);
            return;
          }
          account.password = request.postDataJSON().password;
          account.mustChangePassword = false;
          await json(route, { session: {
            username: account.username,
            displayName: account.displayName,
            role: account.role,
            mustChangePassword: false,
          } });
          return;
        }
        if (accountPath === 'logout' && method === 'POST') {
          this.username = null;
          this.role = null;
          await json(route, { loggedOut: true });
          return;
        }
        await json(route, { error: { code: 'not_found', message: 'Account route not found.' } }, 404);
        return;
      }
      const segments = url.pathname.slice('/api/library/'.length).split('/').filter(Boolean);
      const method = request.method();
      if (segments[0] === 'assets' && segments.length === 2) this.assetRequestCount += 1;

      const currentAccount = this.username ? this.accounts.get(this.username) : null;
      if (currentAccount?.mustChangePassword && segments[0] !== 'session') {
        await json(route, {
          error: {
            code: 'password_change_required',
            message: 'Change the temporary password before using the library.',
          },
        }, 403);
        return;
      }

      const publicAccount = (account: NonNullable<ReturnType<typeof this.accounts.get>>) => ({
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        status: account.status,
        mustChangePassword: account.mustChangePassword,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      });

      if (segments[0] === 'accounts') {
        if (segments[1] === 'bootstrap' && method === 'POST' && this.role === 'owner' && !this.username) {
          const body = request.postDataJSON();
          const created = {
            id: `account-${body.username}`,
            username: body.username,
            displayName: body.displayName,
            role: 'owner' as const,
            status: 'active' as const,
            mustChangePassword: true,
            password: body.temporaryPassword,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          };
          this.accounts.set(created.username, created);
          await json(route, { account: publicAccount(created) }, 201);
          return;
        }
        const actor = this.username ? this.accounts.get(this.username) : null;
        if (!actor) {
          await json(route, { error: { code: 'unauthenticated', message: 'Authentication is required.' } }, 401);
          return;
        }
        if (actor.role !== 'owner') {
          await json(route, { error: { code: 'forbidden', message: 'Only a native owner may manage accounts.' } }, 403);
          return;
        }
        if (segments.length === 1 && method === 'GET') {
          await json(route, { accounts: [...this.accounts.values()].map(publicAccount) });
          return;
        }
        if (segments.length === 1 && method === 'POST') {
          const body = request.postDataJSON();
          const created = {
            id: `account-${body.username}`,
            username: body.username,
            displayName: body.displayName,
            role: body.role as 'worker' | 'customer',
            status: 'active' as const,
            mustChangePassword: true,
            password: body.temporaryPassword,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
          };
          this.accounts.set(created.username, created);
          await json(route, { account: publicAccount(created) }, 201);
          return;
        }
        const target = [...this.accounts.values()].find(account => account.id === segments[1]);
        if (!target) {
          await json(route, { error: { code: 'account_not_found', message: 'Account not found.' } }, 404);
          return;
        }
        if (segments[2] === 'assignments' && segments.length === 3 && method === 'GET') {
          const projectIds = this.assignments.get(target.id) || new Set();
          await json(route, { assignments: [...projectIds].map(projectId => {
            const official = this.projects.get(projectId)!;
            const draft = [...this.projects.values()].find(project => project.draftOfProjectId === projectId && project.draftOwnerAccountId === target.id)!;
            return { customerId: target.id, projectId, draftProjectId: draft.id, assignedAt: '2026-08-01T00:00:00.000Z', project: metadata(draft), official };
          }) });
          return;
        }
        if (segments[2] === 'assignments' && segments.length === 3 && method === 'POST') {
          const official = this.projects.get(request.postDataJSON().projectId);
          if (!official || target.role !== 'customer' || target.status !== 'active') {
            await json(route, { error: { code: 'invalid_assignment', message: 'Assignments require an active customer and official project.' } }, 400);
            return;
          }
          let draft = [...this.projects.values()].find(project => project.draftOfProjectId === official.id && project.draftOwnerAccountId === target.id);
          if (!draft) draft = this.assignCustomer(target.username, official);
          const assignment = { customerId: target.id, projectId: official.id, draftProjectId: draft.id, assignedAt: '2026-08-01T00:00:00.000Z', project: metadata(draft) };
          await json(route, { assignment }, 201);
          return;
        }
        if (segments[2] === 'assignments' && segments.length === 4 && method === 'DELETE') {
          this.assignments.get(target.id)?.delete(segments[3]);
          await json(route, { unassigned: true });
          return;
        }
        if (segments.length === 3 && method === 'POST') {
          const body = request.postDataJSON();
          if (segments[2] === 'reset') {
            if (target.id === actor.id) {
              await json(route, { error: { code: 'use_change_password', message: 'Use Change Password for your own account.' } }, 409);
              return;
            }
            target.password = body.temporaryPassword;
            target.mustChangePassword = true;
            if (this.username === target.username) {
              this.username = null;
              this.role = null;
            }
          } else if (segments[2] === 'status') {
            if (target.username === actor.username && body.status === 'disabled') {
              await json(route, { error: { code: 'last_owner_required', message: 'At least one active owner is required.' } }, 409);
              return;
            }
            target.status = body.status;
          } else if (segments[2] === 'role') {
            if (target.username === actor.username && body.role !== 'owner') {
              await json(route, { error: { code: 'last_owner_required', message: 'At least one active owner is required.' } }, 409);
              return;
            }
            target.role = body.role;
          }
          await json(route, { account: publicAccount(target) });
          return;
        }
      }

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

      if (segments[0] === 'session' && method === 'GET' && this.sessionProbeFailures > 0) {
        this.sessionProbeFailures -= 1;
        await route.abort('failed');
        return;
      }

      if (!this.role) {
        await json(route, { error: { code: 'unauthenticated', message: 'Authentication is required.', requestId: 'fixture-401' } }, 401);
        return;
      }
      if (segments[0] === 'session' && method === 'GET') {
        const account = this.username ? this.accounts.get(this.username) : null;
        await json(route, { session: account ? {
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          mustChangePassword: account.mustChangePassword,
        } : { email: this.email, role: this.role } });
        return;
      }
      if (segments[0] === 'assets' && segments.length === 2) {
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot access workspace assets.' } }, 403);
          return;
        }
        const kind = segments[1];
        if (method === 'GET') {
          const failure = this.assetReadFailures.shift();
          if (failure) {
            await json(route, { error: { code: `fixture_asset_read_${failure}`, message: `Fixture asset read failure ${failure}.`, requestId: `fixture-asset-read-${failure}` } }, failure);
            return;
          }
          const asset = this.assets.get(kind);
          if (this.heldAssetReadsRemaining > 0) {
            this.heldAssetReadsRemaining -= 1;
            if (this.heldAssetReadsRemaining === 0) this.signalDelayedAssetReadsStarted?.();
            await this.delayedAssetReadGate;
          }
          if (!asset) {
            await json(route, { error: { code: 'not_found', message: 'Workspace asset not found.', requestId: 'fixture-asset-404' } }, 404);
            return;
          }
          await json(route, { asset: this.assetResponse(asset) });
          return;
        }
        if (method === 'PUT') {
          this.assetWriteCount += 1;
          const requestId = request.headers()['x-lightweaver-request'] || '';
          this.assetWriteRequestIds.push(requestId);
          const accepted = this.acceptedAssetRequests.get(requestId);
          if (accepted) {
            await json(route, { error: { code: 'idempotency_conflict', message: 'The asset request was already accepted.', requestId: 'fixture-asset-idempotency' } }, 409);
            return;
          }
          const failure = this.assetWriteFailures.shift();
          if (failure) {
            await json(route, { error: { code: `fixture_${failure}`, message: `Fixture asset failure ${failure}.`, requestId: `fixture-asset-${failure}` } }, failure);
            return;
          }
          const body = request.postDataJSON();
          if (this.delayedAssetWriteGate) {
            this.signalDelayedAssetWriteStarted?.();
            await this.delayedAssetWriteGate;
            this.delayedAssetWriteGate = null;
          }
          const asset = this.assets.get(kind);
          if (body.baseRevision !== (asset?.revision || 0)) {
            await json(route, { error: { code: 'revision_conflict', message: 'The workspace asset changed online.', requestId: 'fixture-asset-409' } }, 409);
            return;
          }
          const updated = this.seedAsset(kind, body.value);
          updated.revisions[updated.revisions.length - 1].editor = this.email;
          this.acceptedAssetRequests.set(requestId, { kind, value: structuredClone(body.value) });
          if (this.delayedAssetSuccessGate) {
            this.signalDelayedAssetSuccessStarted?.();
            await this.delayedAssetSuccessGate;
            this.delayedAssetSuccessGate = null;
          }
          if (this.loseNextAssetWriteResponse) {
            this.loseNextAssetWriteResponse = false;
            await route.abort('failed');
            return;
          }
          await json(route, { asset: this.assetResponse(updated) });
          return;
        }
      }
      if (segments[0] === 'projects' && segments.length === 1 && method === 'GET') {
        const archived = url.searchParams.get('state') === 'archived';
        const actor = this.username ? this.accounts.get(this.username) : null;
        const visible = [...this.projects.values()].filter(item => {
          if (item.archived !== archived) return false;
          if (actor?.role === 'customer') return item.draftOwnerAccountId === actor.id && this.assignments.get(actor.id)?.has(item.draftOfProjectId || '');
          return !item.draftOfProjectId;
        });
        await json(route, { projects: visible.map(item => {
          const value = metadata(item);
          if (actor?.role === 'customer') {
            delete value.createdBy;
            delete value.lastEditor;
          }
          return value;
        }) });
        return;
      }
      if (segments[0] === 'projects' && segments.length === 1 && method === 'POST') {
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot create shared projects.' } }, 403);
          return;
        }
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
          const actor = this.username ? this.accounts.get(this.username) : null;
          if (actor?.role === 'customer' && (project.draftOwnerAccountId !== actor.id || !this.assignments.get(actor.id)?.has(project.draftOfProjectId || ''))) {
            await json(route, { error: { code: 'not_found', message: 'Project not found.' } }, 404);
            return;
          }
          const failure = this.projectReadFailures.shift();
          if (failure) {
            await json(route, { error: { code: `fixture_${failure}`, message: `Fixture read failure ${failure}.`, requestId: `fixture-read-${failure}` } }, failure);
            return;
          }
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
          const actor = this.username ? this.accounts.get(this.username) : null;
          if (actor?.role === 'customer' && (project.draftOwnerAccountId !== actor.id || !this.assignments.get(actor.id)?.has(project.draftOfProjectId || ''))) {
            await json(route, { error: { code: 'forbidden', message: 'Customers may update only their assigned draft.' } }, 403);
            return;
          }
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
      if (segments[0] === 'projects' && project && segments[2] === 'drafts' && method === 'GET') {
        if (this.role !== 'owner') {
          await json(route, { error: { code: 'forbidden', message: 'Only owners may review customer drafts.' } }, 403);
          return;
        }
        await json(route, { drafts: [...this.projects.values()].filter(item => item.draftOfProjectId === project.id).map(metadata) });
        return;
      }
      if (segments[0] === 'projects' && project?.draftOfProjectId && segments[2] === 'promote' && method === 'POST') {
        if (this.role !== 'owner') {
          await json(route, { error: { code: 'forbidden', message: 'Only owners may promote customer drafts.' } }, 403);
          return;
        }
        const body = request.postDataJSON();
        this.promotionBodies.push(body);
        const official = this.projects.get(project.draftOfProjectId)!;
        if (body.officialBaseRevision !== official.revision || body.draftBaseRevision !== project.revision) {
          await json(route, { error: { code: 'revision_conflict', message: 'The library record changed since it was opened.' } }, 409);
          return;
        }
        official.revision += 1;
        official.document = structuredClone(project.document);
        official.updatedAt = `2026-08-01T${String(official.revision).padStart(2, '0')}:55:00.000Z`;
        official.revisions.push({ revision: official.revision, archived: false, createdAt: official.updatedAt, editor: this.email, document: structuredClone(official.document) });
        await json(route, { project: metadata(official) });
        return;
      }
      if (segments[0] === 'projects' && project && segments[2] === 'duplicate' && method === 'POST') {
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot duplicate projects.' } }, 403);
          return;
        }
        const body = request.postDataJSON();
        const title = body.title || `${project.title} Copy`;
        const duplicate = this.seed(title, { revisions: [{ ...structuredClone(project.document), id: `lwproj-copy-${this.nextId}`, name: title }] });
        await json(route, { project: metadata(duplicate) }, 201);
        return;
      }
      if (segments[0] === 'projects' && project && ['archive', 'unarchive'].includes(segments[2]) && method === 'POST') {
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot archive projects.' } }, 403);
          return;
        }
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
          ...(this.role === 'customer' ? {} : { editor: item.editor }),
        })) });
        return;
      }
      if (segments[0] === 'projects' && project && segments[2] === 'revisions' && segments[4] === 'restore' && method === 'POST') {
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot restore project revisions.' } }, 403);
          return;
        }
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
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot export the shared library.' } }, 403);
          return;
        }
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
          workspaceAssets: [...this.assets.values()].map(asset => ({
            kind: asset.kind,
            currentRevision: asset.revision,
            revisions: asset.revisions.map(revision => ({
              revision: revision.revision,
              createdAt: revision.createdAt,
              value: structuredClone(revision.value),
            })),
          })),
        });
        return;
      }
      if (segments[0] === 'restore' && method === 'POST') {
        if (this.role === 'customer') {
          await json(route, { error: { code: 'forbidden', message: 'Customers cannot import the shared library.' } }, 403);
          return;
        }
        const backup = request.postDataJSON();
        for (const item of backup.projects || []) {
          const source = item.revisions.find((revision: any) => revision.revision === item.currentRevision);
          this.seed(`${item.title} (restored)`, { archived: item.archived, revisions: [source.document] });
        }
        for (const item of backup.workspaceAssets || []) {
          const source = item.revisions.find((revision: any) => revision.revision === item.currentRevision);
          this.seedAsset(item.kind, source.value);
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

async function waitForAuthenticatedAssets(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await expect(page.getByText('worker@example.test')).toBeVisible();
}

async function saveWorkspaceFixture(page: Page, suffix = '') {
  await page.evaluate(async fixtureSuffix => {
    const { saveCustomPattern, updateCustomPattern } = await import('/src/lib/customPatterns.js');
    const { createPatternLabRecipe } = await import('/src/lib/patternLabRecipe.js');
    const { savePatternLabDraft } = await import('/src/lib/patternLabStorage.js');
    saveCustomPattern({
      id: 'custom-cross-device',
      name: `Cross-device glow${fixtureSuffix}`,
      code: 'return rgb(0.1, 0.2, 0.3);',
      palette: ['#112233', '#445566'],
    });
    updateCustomPattern('custom-cross-device', {
      code: 'return rgb(0.4, 0.5, 0.6);',
    });
    savePatternLabDraft(createPatternLabRecipe({
      id: 'draft-cross-device',
      name: `Cross-device study${fixtureSuffix}`,
    }));
  }, suffix);
}

async function freshWorkspacePage(browser: Browser, fixture: LibraryFixture, hash = '#screen=pattern-lab') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await fixture.install(page);
  await page.goto(`/${hash}`, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

test('top-bar Load lists only active online projects, filters them, and opens the selected project', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Amber Canopy');
  fixture.seed('Blue Current');
  fixture.seed('Archived Study', { archived: true });
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Amber Canopy', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Blue Current', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Archived Study', { exact: true })).toHaveCount(0);

  await dialog.getByRole('searchbox', { name: 'Search projects' }).fill('blue');
  await expect(dialog.getByText('Amber Canopy', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Open Blue Current' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.crumb .proj')).toHaveText('Blue Current');
});

test('top-bar Load imports a project from the computer through replacement flow', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  const chooserPromise = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Import from computer' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: 'computer-project.lightweaver.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(portable('Computer Project'))),
  });

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.crumb .proj')).toHaveText('Computer Project');
});

test('signed-out Load shows guidance and routes to Preferences without exposing projects', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  fixture.seed('Private Online Project');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await expect(dialog).toContainText('Sign in from Preferences to open online projects.');
  await expect(dialog.getByText('Private Online Project', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Open Preferences' }).click();
  await expect(page.getByTestId('project-library-panel')).toBeVisible();
});

test('top-bar Load keeps browser saves recoverable after New while signed out', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  const savedProject = portable('Browser recovery piece', 'lwproj-browser-recovery');
  await page.addInitScript((project) => {
    localStorage.setItem('lw_project_library_v1', JSON.stringify({
      version: 1,
      records: [{
        id: 'browser-recovery-record',
        name: project.name,
        createdAt: 1,
        updatedAt: 2,
        projectVersion: project.version,
        project,
      }],
    }));
    localStorage.setItem('lw_project_active_record_v1', 'browser-recovery-record');
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(project));
    localStorage.setItem('lw_project_lifecycle_v1', JSON.stringify({
      version: 2,
      dirty: false,
      persistedDestination: 'browser',
      installation: {
        cardId: 'lw-prior-card',
        projectRevision: 0,
        projectFingerprint: '0123456789abcdef',
      },
    }));
  }, savedProject);
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await expect(dialog.getByText('Browser recovery piece', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Open Browser recovery piece' }).click();

  await page.getByRole('button', { name: 'Preferences' }).first().click();
  await expect(page.getByLabel('Project name')).toHaveValue('Browser recovery piece');
  await expect.poll(() => page.evaluate(() => ({
    activeRecordId: localStorage.getItem('lw_project_active_record_v1'),
    lifecycle: JSON.parse(localStorage.getItem('lw_project_lifecycle_v1') || '{}'),
  }))).toEqual({
    activeRecordId: 'browser-recovery-record',
    lifecycle: {
      version: 2,
      dirty: false,
      persistedDestination: 'browser',
      installation: null,
    },
  });
});

test('claimed browser records remain available to signed-out Save, New, and Load', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const savedProject = portable('Claimed browser piece', 'lwproj-claimed-browser');
  await page.addInitScript((project) => {
    const record = {
      id: 'claimed-browser-record',
      name: project.name,
      createdAt: 1,
      updatedAt: 2,
      projectVersion: project.version,
      project,
    };
    localStorage.setItem('lw_project_library_v1', JSON.stringify({ version: 1, records: [record] }));
    localStorage.setItem('lw_project_active_record_v1', record.id);
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(project));
    localStorage.setItem('lw_project_lifecycle_v1', JSON.stringify({
      version: 2,
      dirty: false,
      persistedDestination: 'browser',
      installation: null,
    }));
  }, savedProject);
  await fixture.install(page);
  await openLibrary(page);

  await page.getByRole('button', { name: 'Bring browser projects online' }).click();
  await expect(page.getByText('1 browser project brought online')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Project name').fill('Claimed browser piece revised');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (
    JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.[0]?.name
  ))).toBe('Claimed browser piece revised');

  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await expect(dialog.getByText('Claimed browser piece revised', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Open Claimed browser piece revised' }).click();

  await expect(page.locator('.crumb .proj')).toHaveText('Claimed browser piece revised');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_project_active_record_v1')))
    .toBe('claimed-browser-record');
});

test('browser Load keeps Save fail-closed when its guarded association goes stale', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  const savedProject = portable('Stale association target', 'lwproj-stale-association');
  await page.addInitScript((project) => {
    localStorage.setItem('lw_project_library_v1', JSON.stringify({
      version: 1,
      records: [{
        id: 'stale-association-record',
        name: project.name,
        createdAt: 1,
        updatedAt: 2,
        projectVersion: project.version,
        project,
      }],
    }));
  }, savedProject);
  await fixture.install(page);
  await page.goto('/#screen=card&section=preferences', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Project name').fill('Unsaved current work');

  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' })
    .getByRole('button', { name: 'Open Stale association target' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Replace current project?' });
  await expect(confirmation).toBeVisible();
  await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}');
    library.records = [];
    localStorage.setItem('lw_project_library_v1', JSON.stringify(library));
  });
  await confirmation.getByRole('button', { name: 'Replace project' }).click();
  await expect(page.locator('.crumb .proj')).toHaveText('Stale association target');

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByTestId('workspace-notice')).toContainText(
    'Saving is blocked because Studio could not establish a safe destination',
  );
  await expect.poll(() => page.evaluate(() => (
    JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.length
  ))).toBe(0);

  await page.getByRole('button', { name: 'New project' }).click();
  const discard = page.getByRole('dialog', { name: 'Replace current project?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect.poll(() => page.evaluate(() => ({
    name: JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}').name,
    dirty: JSON.parse(localStorage.getItem('lw_project_lifecycle_v1') || '{}').dirty,
  }))).toEqual({ name: 'Stale association target', dirty: true });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.crumb .proj')).toHaveText('Stale association target');
});

test('association failure remains fail-closed after reload and cannot overwrite a newer same-project record', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  const savedProject = portable('Recovery before association', 'lwproj-reload-association');
  await page.addInitScript((project) => {
    if (sessionStorage.getItem('reload-association-seeded') === 'true') return;
    sessionStorage.setItem('reload-association-seeded', 'true');
    localStorage.setItem('lw_project_library_v1', JSON.stringify({
      version: 1,
      records: [{
        id: 'reload-association-record',
        name: project.name,
        createdAt: 1,
        updatedAt: 2,
        projectVersion: project.version,
        project,
      }],
    }));
    localStorage.setItem('lw_project_active_record_v1', 'reload-association-record');
  }, savedProject);
  await fixture.install(page);
  await page.goto('/#screen=card&section=preferences', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Project name').fill('Unsaved workspace before recovery');

  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' })
    .getByRole('button', { name: 'Open Recovery before association' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Replace current project?' });
  await expect(confirmation).toBeVisible();
  await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}');
    const record = library.records[0];
    record.name = 'Newer cross-tab revision';
    record.project.name = record.name;
    record.updatedAt = 3;
    localStorage.setItem('lw_project_library_v1', JSON.stringify(library));
  });
  await expect.poll(() => page.evaluate(() => {
    const record = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.[0];
    return { name: record?.name, updatedAt: record?.updatedAt };
  })).toEqual({ name: 'Newer cross-tab revision', updatedAt: 3 });
  await confirmation.getByRole('button', { name: 'Replace project' }).click();
  await expect.poll(() => page.evaluate(() => ({
    name: JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}').name,
    dirty: JSON.parse(localStorage.getItem('lw_project_lifecycle_v1') || '{}').dirty,
  }))).toEqual({ name: 'Recovery before association', dirty: true });
  await expect.poll(() => page.evaluate(() => {
    const record = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.[0];
    return { name: record?.name, updatedAt: record?.updatedAt };
  })).toEqual({ name: 'Newer cross-tab revision', updatedAt: 3 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.crumb .proj')).toHaveText('Recovery before association');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByTestId('workspace-notice')).toContainText('Saving is blocked');
  await expect.poll(() => page.evaluate(() => {
    const record = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.[0];
    return { name: record?.name, updatedAt: record?.updatedAt };
  })).toEqual({ name: 'Newer cross-tab revision', updatedAt: 3 });
});

test('late browser association cannot attach to a superseding New workspace', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  const savedProject = portable('Held association target', 'lwproj-held-association');
  await page.addInitScript((project) => {
    localStorage.setItem('lw_project_library_v1', JSON.stringify({
      version: 1,
      records: [{
        id: 'held-association-record',
        name: project.name,
        createdAt: 1,
        updatedAt: 2,
        projectVersion: project.version,
        project,
      }],
    }));
  }, savedProject);
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    let release;
    (window as any).__heldProjectLockReady = false;
    (window as any).__releaseHeldProjectLock = () => release?.();
    (window as any).__heldProjectLock = navigator.locks.request(
      'lightweaver-project-library-save-v1',
      async () => {
        (window as any).__heldProjectLockReady = true;
        await new Promise(resolve => { release = resolve; });
      },
    );
  });
  await expect.poll(() => page.evaluate(() => (window as any).__heldProjectLockReady)).toBe(true);

  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' })
    .getByRole('button', { name: 'Open Held association target' }).click();
  await expect(page.locator('.crumb .proj')).toHaveText('Held association target');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.crumb .proj')).not.toHaveText('Held association target');

  await page.evaluate(() => (window as any).__releaseHeldProjectLock());
  await page.evaluate(() => (window as any).__heldProjectLock);
  await expect(page.locator('.crumb .proj')).not.toHaveText('Held association target');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lw_project_active_record_v1'))).toBeNull();

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByTestId('workspace-notice')).not.toContainText('Saving is blocked');
});

test('Load closes with Escape and restores focus to the top-bar action', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Focus Study');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const load = page.getByRole('button', { name: 'Load project' });
  await load.click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await expect(dialog.getByRole('searchbox', { name: 'Search projects' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(load).toBeFocused();
});

test('Load closes immediately and reports a failed online project read persistently', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Unavailable Project');
  fixture.projectReadFailures.push(503);
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await dialog.getByRole('button', { name: 'Open Unavailable Project' }).click();
  await expect(dialog).toHaveCount(0);

  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Fixture read failure 503.');
  await expect(notice.getByRole('button', { name: 'Review' })).toBeVisible();
  await page.waitForTimeout(2400);
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toHaveCount(0);
});

test('first authenticated top-bar Save prompts for a title and creates an associated online project', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  const sessionResponse = page.waitForResponse('**/api/account/session');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await sessionResponse;

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save project online' });
  await expect(dialog).toBeVisible();
  expect(fixture.projects.size).toBe(0);
  await dialog.getByLabel('Project title').fill('Top-bar Gallery');
  await dialog.getByRole('button', { name: 'Save online' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/#screen=layout/);
  await expect.poll(() => [...fixture.projects.values()].map(project => project.title)).toEqual(['Top-bar Gallery']);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_cloud_active_project_v1') || 'null')?.revision)).toBe(1);
});

test('first online Save explains a session change while keeping the dialog usable', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Preferences').first().click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  fixture.holdNextCreate();
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save project online' });
  await dialog.getByLabel('Project title').fill('Stale Session Project');
  await dialog.getByRole('button', { name: 'Save online' }).click();
  await fixture.delayedCreateStarted;
  await page.evaluate(() => {
    const signOut = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Sign out');
    if (!(signOut instanceof HTMLButtonElement)) throw new Error('Sign out action not found');
    signOut.click();
  });
  await expect.poll(() => fixture.role).toBeNull();
  fixture.releaseCreate();

  await expect(dialog.getByRole('alert')).toHaveText('Your session changed. Sign in again from Preferences.');
  await expect(dialog.getByLabel('Project title')).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Save online' })).toBeEnabled();
});

test('top-bar Save writes an associated authenticated project through the online revision path', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Associated Project');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Associated Project' }).click();
  await page.getByLabel('Preferences').first().click();
  await page.getByLabel('Project name').fill('Associated Project Revised');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();

  await expect(page.getByRole('dialog', { name: 'Save project online' })).toHaveCount(0);
  await expect.poll(() => fixture.updateCount).toBe(1);
  await expect.poll(() => fixture.projects.get(remote.id)?.revision).toBe(2);
  expect(fixture.projects.get(remote.id)?.document.name).toBe('Associated Project Revised');
});

test('associated Save error dismissal and recovery do not reveal a stale workspace error', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Recoverable Save');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Recoverable Save' }).click();
  await page.getByLabel('Preferences').first().click();
  await page.getByLabel('Project name').fill('Recoverable Save Revised');
  fixture.updateFailures.push(400);

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Online save needs attention.');
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toHaveCount(0);

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect.poll(() => fixture.projects.get(remote.id)?.revision).toBe(2);
  await expect(notice).toContainText('Saved online');
  await expect(notice).not.toContainText('Online save failed');
  await expect(notice).toHaveCount(0, { timeout: 3500 });
});

test('associated Save reports a queued transient failure until its automatic retry succeeds', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const remote = fixture.seed('Transient Save');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Transient Save' }).click();
  await page.getByLabel('Preferences').first().click();
  await page.getByLabel('Project name').fill('Transient Save Revised');
  fixture.updateFailures.push(503);

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Save queued — waiting to retry online.');
  await expect(notice.getByRole('button', { name: 'Review' })).toBeVisible();
  await expect.poll(() => fixture.updateCount, { timeout: 6000 }).toBe(2);
  await expect.poll(() => fixture.projects.get(remote.id)?.revision).toBe(2);
  await expect(notice).toHaveCount(0);
});

test('associated Save authentication rejection reports a persistent sign-in error', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Expired Save');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Expired Save' }).click();
  await page.getByLabel('Preferences').first().click();
  await page.getByLabel('Project name').fill('Expired Save Revised');
  fixture.updateFailures.push(401);

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Your session changed. Sign in again from Preferences.');
  await expect(notice.getByRole('button', { name: 'Review' })).toBeVisible();
  await page.waitForTimeout(2400);
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toHaveCount(0);
});

test('signed-out top-bar Save uses the browser library without leaving the active artboard', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await fixture.install(page);
  const sessionResponse = page.waitForResponse('**/api/account/session');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await sessionResponse;

  await page.getByRole('button', { name: 'Save project', exact: true }).click();

  await expect(page).toHaveURL(/#screen=layout/);
  await expect(page.getByRole('dialog', { name: 'Save project online' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.length || 0)).toBe(1);
});

test('reloaded browser project keeps its exact save association instead of creating duplicates', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await fixture.install(page);
  let sessionResponse = page.waitForResponse('**/api/account/session');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await sessionResponse;

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.length || 0)).toBe(1);

  sessionResponse = page.waitForResponse('**/api/account/session');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sessionResponse;
  const restoredAssociation = await page.evaluate(() => {
    const records = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records || [];
    const autosave = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return {
      activeRecordId: localStorage.getItem('lw_project_active_record_v1'),
      autosaveProjectId: autosave.id,
      records: records.map((record: any) => ({ id: record.id, projectId: record.project?.id })),
    };
  });
  expect(restoredAssociation.activeRecordId).toBe(restoredAssociation.records[0]?.id);
  expect(restoredAssociation.autosaveProjectId).toBe(restoredAssociation.records[0]?.projectId);
  await page.getByLabel('Preferences').first().click();
  await page.getByLabel('Project name').fill('Reloaded browser project');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();

  await expect.poll(() => page.evaluate(() => {
    const records = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records || [];
    return { count: records.length, name: records[0]?.project?.name };
  })).toEqual({ count: 1, name: 'Reloaded browser project' });
});

test('customer top-bar Save keeps unassociated work in browser and saves only an opened assigned draft online', async ({ page }) => {
  const fixture = new LibraryFixture('customer', 'client@example.test');
  const official = fixture.seed('Official Installation');
  const draft = fixture.assignCustomer('client', official);
  const officialRevision = official.revision;
  const projectCount = fixture.projects.size;
  await fixture.install(page);
  const sessionResponse = page.waitForResponse('**/api/account/session');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await sessionResponse;

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save project online' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}').records?.length || 0)).toBe(1);
  expect(fixture.projects.size).toBe(projectCount);
  expect(official.revision).toBe(officialRevision);
  expect(draft.revision).toBe(1);

  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Official Installation' }).click();
  await page.getByLabel('Preferences').first().click();
  await page.getByLabel('Project name').fill('Customer Draft Revision');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();

  await expect.poll(() => draft.revision).toBe(2);
  expect(draft.document.name).toBe('Customer Draft Revision');
  expect(official.revision).toBe(officialRevision);
  expect(official.document.name).toBe('Official Installation');
  expect(fixture.projects.size).toBe(projectCount);
});

test('workspace notice shows explicit browser-save success, supports dismissal, and auto-clears', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await fixture.install(page);
  const sessionResponse = page.waitForResponse('**/api/account/session');
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await sessionResponse;

  await expect(page.locator('.savechip')).toHaveCount(0);
  await expect(page.getByTestId('workspace-notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('saved in browser library');
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toHaveCount(0);

  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCount(0, { timeout: 3500 });
});

test('workspace notice reports recovery briefly without surfacing passive lifecycle labels', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await page.addInitScript(project => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(project));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(project));
  }, portable('Recovered Notice Project'));
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Restored from recovery copy');
  await expect(page.locator('body')).not.toContainText('Unsaved changes');
  await expect(notice).toHaveCount(0, { timeout: 3500 });
});

test('conflict notice persists until dismissed and offers Preferences review', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Conflict Notice Project');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Conflict Notice Project' }).click();
  await page.getByLabel('Preferences').first().click();
  fixture.forceNextConflict = true;
  await page.getByLabel('Project name').fill('Conflicting local revision');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();

  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Online conflict');
  await notice.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByTestId('project-library-panel')).toBeVisible();
  await page.waitForTimeout(2400);
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await page.waitForTimeout(500);
  await expect(notice).toHaveCount(0);
});

test('offline and error notices persist, remember dismissal, and reappear after state re-entry', async ({ page, context }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Persistent Notice Project');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Load project' }).click();
  await page.getByRole('dialog', { name: 'Load project' }).getByRole('button', { name: 'Open Persistent Notice Project' }).click();

  await context.setOffline(true);
  const notice = page.getByTestId('workspace-notice');
  await expect(notice).toContainText('Offline');
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await page.waitForTimeout(2400);
  await expect(notice).toHaveCount(0);
  await context.setOffline(false);
  await context.setOffline(true);
  await expect(notice).toContainText('Offline');
  await context.setOffline(false);

  await page.getByLabel('Preferences').first().click();
  fixture.updateFailures.push(400);
  await page.getByLabel('Project name').fill('Save error notice');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await expect(notice).toContainText('Online save needs attention');
  await page.waitForTimeout(2400);
  await expect(notice).toBeVisible();
});

for (const width of [320, 390]) {
  test(`${width}px keeps five top actions and compact dialogs inside the viewport`, async ({ page }) => {
    const fixture = new LibraryFixture(null);
    await fixture.install(page);
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

    const actions = ['New project', 'Load project', 'Preferences', 'Export project', 'Save project'];
    const boxes = [];
    for (const name of actions) {
      const action = page.getByRole('button', { name, exact: true });
      await expect(action).toBeVisible();
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      boxes.push(box!);
    }
    for (let index = 1; index < boxes.length; index += 1) {
      expect(boxes[index].x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole('button', { name: 'Load project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Load project' });
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(760);
    const closeBox = await dialog.getByRole('button', { name: 'Close Load project' }).boundingBox();
    expect(closeBox!.width).toBeGreaterThanOrEqual(44);
    expect(closeBox!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    const noticeBox = await page.getByTestId('workspace-notice').boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(noticeBox!.x).toBeGreaterThanOrEqual(58);
    expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(width);
    for (const box of boxes) {
      expect(noticeBox!.y).toBeGreaterThanOrEqual(box.y + box.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const width of [320, 390]) {
  test(`${width}px signed-in Load keeps search and project controls touch-sized`, async ({ page }) => {
    const fixture = new LibraryFixture('worker');
    fixture.seed('Touch Target Project');
    await fixture.install(page);
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: 'Load project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Load project' });
    const controls = [
      dialog.getByRole('searchbox', { name: 'Search projects' }),
      dialog.getByRole('button', { name: 'Open Touch Target Project' }),
      dialog.getByRole('button', { name: 'Import from computer' }),
    ];
    for (const control of controls) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  });
}

async function installAuthEpochHarness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    document.body.innerHTML = '<div id="auth-epoch-root"></div>';
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { CloudLibraryProvider, useCloudLibrary } = await import('/src/state/CloudLibraryContext.jsx');
    const { ProjectProvider } = await import('/src/state/ProjectContext.jsx');

    const identities = {
      'account-a': { username: 'account-a', displayName: 'Account A', role: 'customer', mustChangePassword: false },
      'account-b': { username: 'account-b', displayName: 'Account B', role: 'customer', mustChangePassword: false },
    };
    const projects = {
      'account-a': { id: 'project-a', title: 'Account A private project', archived: false, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
      'account-b': { id: 'project-b', title: 'Account B private project', archived: false, revision: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    };
    const state = {
      username: 'account-a',
      api: null,
      heldProjectCalls: 0,
      projectRefreshStarted: null,
      releaseProjectRefresh: null,
      accountRefreshStarted: null,
      releaseAccountRefresh: null,
      sessionRefreshStarted: null,
      releaseSessionRefresh: null,
      holdProjects: false,
      holdAccounts: false,
      holdSession: false,
      refreshSettled: false,
      accountsSettled: false,
      sessionSettled: false,
      accountRequestStarted: false,
      sessionRequestStarted: false,
    };
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    state.prepareProjectRefresh = () => {
      const started = deferred();
      const release = deferred();
      state.heldProjectCalls = 0;
      state.projectRefreshStarted = started.promise;
      state.releaseProjectRefresh = release.resolve;
      state.projectStartedResolve = started.resolve;
      state.projectGate = release.promise;
      state.holdProjects = true;
    };
    state.prepareAccountRefresh = () => {
      const started = deferred();
      const release = deferred();
      state.accountRefreshStarted = started.promise;
      state.releaseAccountRefresh = release.resolve;
      state.accountStartedResolve = started.resolve;
      state.accountGate = release.promise;
      state.holdAccounts = true;
    };
    state.prepareSessionRefresh = () => {
      const started = deferred();
      const release = deferred();
      state.sessionRefreshStarted = started.promise;
      state.releaseSessionRefresh = release.resolve;
      state.sessionStartedResolve = started.resolve;
      state.sessionGate = release.promise;
      state.holdSession = true;
    };

    const client = {
      getAccountSession: async () => {
        const captured = state.username;
        if (state.holdSession && captured === 'account-a') {
          state.holdSession = false;
          state.sessionRequestStarted = true;
          state.sessionStartedResolve();
          await state.sessionGate;
        }
        if (!captured) throw Object.assign(new Error('Authentication is required.'), { status: 401 });
        return { ...identities[captured] };
      },
      getSession: async () => { throw Object.assign(new Error('Authentication is required.'), { status: 401 }); },
      login: async ({ username }) => {
        state.username = username;
        return { ...identities[username] };
      },
      logout: async () => { state.username = null; },
      listProjects: async ({ state: projectState }) => {
        const captured = state.username;
        const result = projectState === 'active' && captured ? [{ ...projects[captured] }] : [];
        if (state.holdProjects && captured === 'account-a') {
          state.heldProjectCalls += 1;
          if (state.heldProjectCalls === 2) state.projectStartedResolve();
          await state.projectGate;
          if (state.heldProjectCalls === 2) state.holdProjects = false;
        }
        return result;
      },
      listAccounts: async () => {
        const captured = state.username;
        const result = [{ id: `${captured}-secret`, username: `${captured}-managed`, displayName: `${captured} managed account`, role: 'customer', status: 'active', mustChangePassword: false, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }];
        if (state.holdAccounts && captured === 'account-a') {
          state.accountRequestStarted = true;
          state.accountStartedResolve();
          await state.accountGate;
          state.holdAccounts = false;
        }
        return result;
      },
    };

    function Harness() {
      const library = useCloudLibrary();
      const [accounts, setAccounts] = React.useState([]);
      const boundary = `${library.session.status}:${library.session.username || ''}:${library.session.role || ''}`;
      React.useEffect(() => setAccounts([]), [boundary]);
      state.api = library;
      state.loadAccounts = async () => {
        const result = await library.listAccounts();
        if (result.ok) setAccounts(result.value);
        return result;
      };
      return React.createElement('div', null,
        React.createElement('span', { 'data-testid': 'epoch-session' }, `${library.session.status}:${library.session.username || ''}:${library.session.role || ''}`),
        React.createElement('span', { 'data-testid': 'epoch-projects' }, library.activeProjects.map(project => project.title).join('|')),
        React.createElement('span', { 'data-testid': 'epoch-accounts' }, accounts.map(account => account.displayName).join('|')),
      );
    }

    const root = createRoot(document.getElementById('auth-epoch-root'));
    root.render(React.createElement(ProjectProvider, null,
      React.createElement(CloudLibraryProvider, { client }, React.createElement(Harness))));
    window.__LW_AUTH_EPOCH__ = state;
  });
  await expect(page.getByTestId('epoch-session')).toHaveText('authenticated:account-a:customer');
  await expect(page.getByTestId('epoch-projects')).toHaveText('Account A private project');
}

test('ignores delayed project and account refreshes from the previous authenticated account', async ({ page }) => {
  await installAuthEpochHarness(page);
  await page.evaluate(() => {
    const state = window.__LW_AUTH_EPOCH__;
    state.prepareProjectRefresh();
    state.prepareAccountRefresh();
    state.refreshPromise = state.api.refreshProjects().finally(() => { state.refreshSettled = true; });
    state.accountsPromise = state.loadAccounts().finally(() => { state.accountsSettled = true; });
  });
  await expect.poll(() => page.evaluate(() => window.__LW_AUTH_EPOCH__.heldProjectCalls)).toBe(2);
  await expect.poll(() => page.evaluate(() => window.__LW_AUTH_EPOCH__.accountRequestStarted)).toBe(true);

  await page.evaluate(async () => {
    const state = window.__LW_AUTH_EPOCH__;
    const api = state.api;
    await api.logout();
    await api.login({ username: 'account-b', password: 'account-b-password' });
  });
  await expect(page.getByTestId('epoch-session')).toHaveText('authenticated:account-b:customer');
  await expect(page.getByTestId('epoch-projects')).toHaveText('Account B private project');
  await expect(page.getByTestId('epoch-accounts')).toHaveText('');

  await page.evaluate(async () => {
    const state = window.__LW_AUTH_EPOCH__;
    state.releaseProjectRefresh();
    state.releaseAccountRefresh();
    await Promise.all([state.refreshPromise, state.accountsPromise]);
  });
  await expect(page.getByTestId('epoch-session')).toHaveText('authenticated:account-b:customer');
  await expect(page.getByTestId('epoch-projects')).toHaveText('Account B private project');
  await expect(page.getByTestId('epoch-accounts')).toHaveText('');
});

test('ignores a delayed session probe from account A after account B authenticates', async ({ page }) => {
  await installAuthEpochHarness(page);
  await page.evaluate(() => {
    const state = window.__LW_AUTH_EPOCH__;
    state.prepareSessionRefresh();
    state.sessionPromise = state.api.retrySession().finally(() => { state.sessionSettled = true; });
  });
  await expect.poll(() => page.evaluate(() => window.__LW_AUTH_EPOCH__.sessionRequestStarted)).toBe(true);

  await page.evaluate(async () => {
    const state = window.__LW_AUTH_EPOCH__;
    const api = state.api;
    await api.logout();
    await api.login({ username: 'account-b', password: 'account-b-password' });
  });
  await expect(page.getByTestId('epoch-session')).toHaveText('authenticated:account-b:customer');
  await expect(page.getByTestId('epoch-projects')).toHaveText('Account B private project');

  await page.evaluate(async () => {
    const state = window.__LW_AUTH_EPOCH__;
    state.releaseSessionRefresh();
    await state.sessionPromise;
  });
  await expect(page.getByTestId('epoch-session')).toHaveText('authenticated:account-b:customer');
  await expect(page.getByTestId('epoch-projects')).toHaveText('Account B private project');
});

test('signs in with native credentials, reports bad credentials generically, and signs out safely', async ({ page }) => {
  const fixture = new LibraryFixture(null);
  await fixture.install(page);
  await openLibrary(page);
  await expect(page.getByLabel('Username')).toBeVisible();
  await page.getByLabel('Username').fill('worker');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Invalid username or password.')).toBeVisible();

  await page.getByLabel('Password').fill('temporary-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('@worker')).toBeVisible();
  await expect(page.getByText('Worker', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Username')).toBeVisible();
  const assetRequestsAfterLogout = fixture.assetRequestCount;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(100);
  expect(fixture.assetRequestCount).toBe(assetRequestsAfterLogout);
});

test('requires a temporary-password session to choose and confirm a personal password', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.accounts.get('worker')!.mustChangePassword = true;
  await fixture.install(page);
  await openLibrary(page);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Current password')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create online project' })).toHaveCount(0);
  expect(fixture.assetRequestCount).toBe(0);

  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await saveWorkspaceFixture(page, '-forced-password');
  await page.waitForTimeout(750);
  expect(fixture.assetRequestCount).toBe(0);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

  const blocked = await page.evaluate(async () => Promise.all([
    fetch('/api/library/projects').then(async response => ({ status: response.status, code: (await response.json()).error?.code })),
    fetch('/api/library/assets/custom-patterns').then(async response => ({ status: response.status, code: (await response.json()).error?.code })),
    fetch('/api/library/accounts').then(async response => ({ status: response.status, code: (await response.json()).error?.code })),
  ]));
  expect(blocked).toEqual([
    { status: 403, code: 'password_change_required' },
    { status: 403, code: 'password_change_required' },
    { status: 403, code: 'password_change_required' },
  ]);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

  await page.getByLabel('New password', { exact: true }).fill('personal-password-123');
  await page.getByLabel('Confirm new password').fill('different-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Passwords do not match.')).toBeVisible();
  await page.getByLabel('Confirm new password').fill('personal-password-123');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('@worker')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create online project' })).toBeVisible();
});

test('offers owner bootstrap only to a verified transitional owner session', async ({ page }) => {
  const fixture = new LibraryFixture(null, 'legacy-owner@example.test');
  fixture.role = 'owner';
  await fixture.install(page);
  await openLibrary(page);
  await expect(page.getByRole('button', { name: 'Create owner account' })).toBeVisible();
  await page.getByLabel('Username').fill('native-owner');
  await page.getByLabel('Display name').fill('Native Owner');
  await page.getByLabel('Temporary password').fill('temporary-owner-password');
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

  const signedOut = new LibraryFixture(null);
  await page.unroute('**/api/**');
  await signedOut.install(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Create owner account' })).toHaveCount(0);
  await expect(page.getByLabel('Username')).toBeVisible();
});

test('owner creates, resets, disables, enables, and changes account roles without exposing self-demotion', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.addAccount('backup-owner', 'owner', {
    displayName: 'Backup Owner',
    password: 'backup-owner-password',
    mustChangePassword: false,
  });
  await fixture.install(page);
  await openLibrary(page);
  const selfRow = page.getByTestId('account-row').filter({ hasText: '@owner' });
  await expect(selfRow.getByRole('button', { name: 'Disable' })).toBeDisabled();
  await expect(selfRow.getByLabel('Role for owner')).toBeDisabled();
  await expect(selfRow.getByLabel('Reset password for owner')).toHaveCount(0);
  await expect(selfRow.getByRole('button', { name: 'Reset password' })).toHaveCount(0);
  await expect(selfRow.getByText('Use Change Password for your own account.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change password' })).toBeVisible();

  const selfReset = await page.evaluate(async id => {
    const response = await fetch(`/api/library/accounts/${id}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ temporaryPassword: 'replacement-owner-password' }),
    });
    return { status: response.status, code: (await response.json()).error?.code };
  }, fixture.accounts.get('owner')!.id);
  expect(selfReset).toEqual({ status: 409, code: 'use_change_password' });

  const backupOwnerRow = page.getByTestId('account-row').filter({ hasText: '@backup-owner' });
  await backupOwnerRow.getByLabel('Reset password for backup-owner').fill('backup-owner-replacement');
  await backupOwnerRow.getByRole('button', { name: 'Reset password' }).click();
  await expect(backupOwnerRow.getByLabel('Reset password for backup-owner')).toHaveValue('');
  expect(fixture.accounts.get('backup-owner')!.mustChangePassword).toBe(true);

  await page.getByLabel('New account username').fill('studio-worker');
  await page.getByLabel('New account display name').fill('Studio Worker');
  await page.getByLabel('Temporary password').fill('temporary-worker-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  const row = page.getByTestId('account-row').filter({ hasText: '@studio-worker' });
  await expect(row).toBeVisible();
  await expect(page.getByLabel('Temporary password')).toHaveValue('');

  await row.getByLabel('Reset password for studio-worker').fill('replacement-worker-password');
  await row.getByRole('button', { name: 'Reset password' }).click();
  await expect(row.getByLabel('Reset password for studio-worker')).toHaveValue('');
  await row.getByLabel('Role for studio-worker').selectOption('customer');
  await expect(row.getByLabel('Role for studio-worker')).toHaveValue('customer');
  await row.getByRole('button', { name: 'Disable' }).click();
  await expect(row.getByText('disabled')).toBeVisible();
  await row.getByRole('button', { name: 'Enable' }).click();
  await expect(row.getByText('active')).toBeVisible();

  fixture.username = null;
  fixture.role = null;
  await page.getByLabel('New account username').fill('revoked-action');
  await page.getByLabel('New account display name').fill('Revoked action');
  await page.getByLabel('Temporary password').fill('revoked-action-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Sign in to use the online project library')).toBeVisible();
});

test('clears owner account and draft-review state across logout and same-page role changes', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.addAccount('studio-worker', 'worker', {
    displayName: 'Studio Worker',
    password: 'studio-worker-password',
    mustChangePassword: false,
  });
  fixture.addAccount('client', 'customer', {
    displayName: 'Client One',
    password: 'client-password-123',
    mustChangePassword: false,
  });
  const official = fixture.seed('Session boundary installation');
  fixture.assignCustomer('client', official);
  await fixture.install(page);
  await openLibrary(page);

  await page.getByLabel('Temporary password').fill('owner-form-secret');
  const clientRow = page.getByTestId('account-row').filter({ hasText: '@client' });
  await clientRow.getByLabel('Reset password for client').fill('owner-reset-secret');
  await page.getByRole('button', { name: 'Review drafts' }).click();
  const review = page.getByRole('region', { name: 'Draft review for Session boundary installation' });
  await expect(review.getByText('Client One · revision 1')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Open draft' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Username', { exact: true })).toBeVisible();
  await expect(page.getByText('Customer drafts')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open draft' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply to main as new revision' })).toHaveCount(0);

  await page.getByLabel('Username', { exact: true }).fill('studio-worker');
  await page.getByLabel('Password', { exact: true }).fill('studio-worker-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('@studio-worker')).toBeVisible();
  await expect(page.getByText('Client One · revision 1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open draft' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.getByLabel('Username', { exact: true }).fill('client');
  await page.getByLabel('Password', { exact: true }).fill('client-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('@client')).toBeVisible();
  await expect(page.getByText('Customer drafts')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply to main as new revision' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out' }).click();

  await page.getByLabel('Username', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('temporary-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('@owner').first()).toBeVisible();
  await expect(page.getByLabel('Temporary password')).toHaveValue('');
  await expect(page.getByTestId('account-row').filter({ hasText: '@client' }).getByLabel('Reset password for client')).toHaveValue('');
  await expect(page.getByText('Customer drafts')).toHaveCount(0);
});

test('owner assigns and unassigns official projects while workers have no account or draft-review APIs', async ({ page }) => {
  const owner = new LibraryFixture('owner');
  owner.addAccount('client', 'customer', { displayName: 'Client One', mustChangePassword: false });
  owner.seed('Official sculpture');
  await owner.install(page);
  await openLibrary(page);
  const customerRow = page.getByTestId('account-row').filter({ hasText: '@client' });
  await customerRow.getByLabel('Project for client').selectOption({ label: 'Official sculpture' });
  await customerRow.getByRole('button', { name: 'Assign' }).click();
  await expect(customerRow.getByText('Official sculpture')).toBeVisible();
  await customerRow.getByRole('button', { name: 'Unassign' }).click();
  await expect(customerRow.getByRole('button', { name: 'Unassign' })).toHaveCount(0);

  await page.unroute('**/api/**');
  const worker = new LibraryFixture('worker');
  const project = worker.seed('Worker project');
  await worker.install(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Accounts', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review drafts' })).toHaveCount(0);
  const statuses = await page.evaluate(async id => Promise.all([
    fetch('/api/library/accounts').then(response => response.status),
    fetch(`/api/library/projects/${id}/drafts`).then(response => response.status),
  ]), project.id);
  expect(statuses).toEqual([403, 403]);
});

test('customer sees only assigned drafts, autosaves them, and cannot use shared-library controls', async ({ page }) => {
  const fixture = new LibraryFixture('customer', 'client@example.test');
  const assigned = fixture.seed('Assigned sculpture');
  fixture.seed('Other sculpture');
  const draft = fixture.assignCustomer('client', assigned);
  await fixture.install(page);
  await openLibrary(page);
  await expect(page.getByText('Assigned sculpture', { exact: true })).toBeVisible();
  await expect(page.getByText('Other sculpture', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Editing your draft')).toBeVisible();
  const libraryPanel = page.getByTestId('project-library-panel');
  for (const name of ['Create online project', 'Rename', 'Duplicate', 'Export', 'Archive', 'Import project', 'Download master backup', 'Restore master backup', 'Review drafts']) {
    await expect(libraryPanel.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  expect(fixture.assetRequestCount).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(100);
  expect(fixture.assetRequestCount).toBe(0);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
  await page.getByLabel('Project name').fill('Customer draft edit');
  await expect.poll(() => fixture.projects.get(draft.id)?.revision).toBe(2);
  const denied = await page.evaluate(async ({ officialId, draftId }) => Promise.all([
    fetch('/api/library/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.status),
    fetch('/api/library/assets/custom-patterns').then(response => response.status),
    fetch('/api/library/backup').then(response => response.status),
    fetch(`/api/library/projects/${officialId}`).then(response => response.status),
    fetch(`/api/library/projects/${draftId}/duplicate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.status),
  ]), { officialId: assigned.id, draftId: draft.id });
  expect(denied).toEqual([403, 403, 403, 404, 403]);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Project history' }).getByRole('button', { name: 'Restore' })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('owner@example.test');
});

test('customer login always returns to assigned active drafts after an owner viewed archives', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.addAccount('client', 'customer', { displayName: 'Client One', password: 'client-password-123', mustChangePassword: false });
  const official = fixture.seed('Assigned after owner');
  fixture.assignCustomer('client', official);
  await fixture.install(page);
  await openLibrary(page);
  await page.getByRole('button', { name: 'Archived projects' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Username', { exact: true }).fill('client');
  await page.getByLabel('Password', { exact: true }).fill('client-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Customer', { exact: true })).toBeVisible();
  await expect(page.getByText('Assigned after owner', { exact: true })).toBeVisible();
});

test('owner reviews and promotes the exact customer draft revision and reports concurrent conflicts', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.addAccount('client', 'customer', { displayName: 'Client One', mustChangePassword: false });
  const official = fixture.seed('Official installation', { revisions: [portable('Official one'), portable('Official two')] });
  const draft = fixture.assignCustomer('client', official);
  await fixture.install(page);
  await openLibrary(page);
  await page.getByRole('button', { name: 'Review drafts' }).click();
  const review = page.getByRole('region', { name: 'Draft review for Official installation' });
  await expect(review.getByText('Client One · revision 1')).toBeVisible();
  draft.document.name = 'Customer draft opened by owner';
  await review.getByRole('button', { name: 'Open draft' }).click();
  await expect(page.getByLabel('Project name')).toHaveValue('Customer draft opened by owner');
  page.once('dialog', dialog => dialog.accept());
  await review.getByRole('button', { name: 'Apply to main as new revision' }).click();
  expect(fixture.promotionBodies).toEqual([{ officialBaseRevision: 2, draftBaseRevision: 1 }]);
  expect(fixture.projects.get(official.id)?.revision).toBe(3);
  await expect(page.getByText('Applied customer draft to the official project as a new revision.')).toBeVisible();

  await page.getByRole('button', { name: 'Review drafts' }).click();
  draft.revision += 1;
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('region', { name: 'Draft review for Official installation' }).getByRole('button', { name: 'Apply to main as new revision' }).click();
  await expect(page.getByText('The library record changed since it was opened.')).toBeVisible();
  expect(fixture.projects.get(official.id)?.revision).toBe(3);
});

test('syncs custom patterns, revision history, and Pattern Lab drafts into a fresh browser before selection', async ({ page, browser }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await openLibrary(page);
  await waitForAuthenticatedAssets(page);

  await saveWorkspaceFixture(page);
  await expect.poll(() => fixture.assets.size).toBe(2);
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatternRevisions['custom-cross-device']?.length).toBe(1);
  expect(fixture.assetWriteCount).toBe(2);

  const fresh = await freshWorkspacePage(browser, fixture);
  try {
    await expect.poll(() => fresh.page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
    await expect(fresh.page.getByLabel('Base pattern')).toContainText('Cross-device glow');
    await expect(fresh.page.getByRole('button', { name: 'Open Cross-device study' })).toBeVisible();
    const snapshot = await fresh.page.evaluate(async () => {
      const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
      return readWorkspaceAssets();
    });
    expect(snapshot.customPatterns[0].id).toBe('custom-cross-device');
    expect(snapshot.customPatternRevisions['custom-cross-device']).toHaveLength(1);
    expect(snapshot.patternLabDrafts[0].id).toBe('draft-cross-device');
  } finally {
    await fresh.context.close();
  }
});

test('keeps valid local workspace assets through an offline save and retries after reconnect', async ({ page, context }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await openLibrary(page);
  await waitForAuthenticatedAssets(page);

  await context.setOffline(true);
  await saveWorkspaceFixture(page, ' offline');
  await expect.poll(() => page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('Cross-device glow offline');
  expect(fixture.assets.size).toBe(0);

  await context.setOffline(false);
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns[0]?.name).toBe('Cross-device glow offline');
  await expect.poll(() => fixture.assets.get('pattern-lab-drafts')?.value.patternLabDrafts[0]?.name).toBe('Cross-device study offline');
});

test('makes stale workspace asset revisions explicit and keeps both named copies on resolution', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-collision', name: 'Shared glow', code: 'return rgb(1, 0, 0);', custom: true }],
    customPatternRevisions: {},
  });
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');

  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-collision', name: 'Shared glow online', code: 'return rgb(0, 0, 1);', custom: true }],
    customPatternRevisions: {},
  });
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-collision', { name: 'Shared glow from this device', code: 'return rgb(0, 1, 0);' });
  });

  const notice = page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Keep both copies' }).click();
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns.length).toBe(2);
  const names = fixture.assets.get('custom-patterns')!.value.customPatterns.map((pattern: any) => pattern.name).sort();
  expect(names).toEqual(['Shared glow from this device (local copy)', 'Shared glow online']);
  expect(new Set(fixture.assets.get('custom-patterns')!.value.customPatterns.map((pattern: any) => pattern.id)).size).toBe(2);
});

test('blocks conflicted asset writes and Keep both incorporates edits made while the stale write was in flight', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-flight', name: 'Flight online', code: 'return rgb(1, 0, 0);', custom: true }],
    customPatternRevisions: {},
  });
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');

  fixture.holdNextAssetWrite();
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-flight', { name: 'Flight local first', code: 'return rgb(0, 1, 0);' });
  });
  await fixture.delayedAssetWriteStarted;
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-flight', name: 'Flight online latest', code: 'return rgb(0, 0, 1);', custom: true }],
    customPatternRevisions: {},
  });
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-flight', { name: 'Flight local second', code: 'return rgb(1, 1, 0);' });
  });
  fixture.releaseAssetWrite();

  const notice = page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' });
  await expect(notice).toBeVisible();
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-flight', { name: 'Flight local final', code: 'return rgb(0, 1, 1);' });
  });
  const writesAtConflict = fixture.assetWriteCount;
  await page.waitForTimeout(700);
  expect(fixture.assetWriteCount).toBe(writesAtConflict);

  await notice.getByRole('button', { name: 'Keep both copies' }).click();
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns.length).toBe(2);
  expect(fixture.assets.get('custom-patterns')!.value.customPatterns.map((pattern: any) => pattern.name).sort())
    .toEqual(['Flight local final (local copy)', 'Flight online latest']);
});

test('bootstraps simultaneous asset conflicts independently and resolves both without claiming unapplied heads', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-multi', name: 'Pattern base', code: 'return rgb(1, 0, 0);', custom: true }],
    customPatternRevisions: {},
  });
  fixture.seedAsset('pattern-lab-drafts', {
    version: 1,
    patternLabDrafts: [],
  });
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    const { createPatternLabRecipe } = await import('/src/lib/patternLabRecipe.js');
    const { savePatternLabDraft } = await import('/src/lib/patternLabStorage.js');
    updateCustomPattern('custom-multi', { name: 'Pattern local', code: 'return rgb(0, 1, 0);' }, { dispatch: false });
    savePatternLabDraft(createPatternLabRecipe({ id: 'draft-multi', name: 'Draft local' }), { dispatch: false });
  });
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-multi', name: 'Pattern online', code: 'return rgb(0, 0, 1);', custom: true }],
    customPatternRevisions: {},
  });
  fixture.seedAsset('pattern-lab-drafts', {
    version: 1,
    patternLabDrafts: [(await import('../src/lib/patternLabRecipe.js')).createPatternLabRecipe({ id: 'draft-multi', name: 'Draft online' })],
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const conflict = page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Keep both copies' }).click();
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Keep both copies' }).click();
  await expect(conflict).toHaveCount(0);
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns.length).toBe(2);
  await expect.poll(() => fixture.assets.get('pattern-lab-drafts')?.value.patternLabDrafts.length).toBe(2);
});

test('ignores an older delayed asset load after a newer load has applied', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-load', name: 'Old remote', code: '', custom: true }],
    customPatternRevisions: {},
  });
  fixture.holdNextAssetLoad();
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await fixture.delayedAssetReadsStarted;
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-load', name: 'New remote', code: '', custom: true }],
    customPatternRevisions: {},
  });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('New remote');
  fixture.releaseAssetReads();
  await page.waitForTimeout(500);
  expect(await page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('New remote');
});

test('does not overwrite a local edit made while the initial asset load is awaiting the network', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-load-edit', name: 'Remote during load', code: '', custom: true }],
    customPatternRevisions: {},
  });
  fixture.holdNextAssetLoad();
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await fixture.delayedAssetReadsStarted;
  await page.evaluate(async () => {
    const { saveCustomPattern } = await import('/src/lib/customPatterns.js');
    saveCustomPattern({ id: 'custom-load-edit', name: 'Local during load', code: '', custom: true }, { dispatch: false });
  });
  fixture.releaseAssetReads();

  await expect(page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('Local during load');
});

test('uploads an offline edit on reload when the remote revision still matches the acknowledged head', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-reload', name: 'Reload base', code: 'return rgb(1, 0, 0);', custom: true }],
    customPatternRevisions: {},
  });
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-reload', { name: 'Reload offline edit', code: 'return rgb(0, 1, 0);' }, { dispatch: false });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' })).toHaveCount(0);
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns[0]?.name).toBe('Reload offline edit');
});

test('reconciles a lost asset response with the same request ID and surfaces divergent replay state', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await openLibrary(page);
  await waitForAuthenticatedAssets(page);

  fixture.loseNextAssetWriteResponse = true;
  await saveWorkspaceFixture(page, ' accepted');
  await expect.poll(() => fixture.assetWriteCount, { timeout: 7000 }).toBeGreaterThanOrEqual(3);
  expect(fixture.assetWriteRequestIds.filter(id => id === fixture.assetWriteRequestIds[0]).length).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' })).toHaveCount(0);

  fixture.loseNextAssetWriteResponse = true;
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-cross-device', { name: 'Divergent local replay' });
  });
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns[0]?.name).toBe('Divergent local replay');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-cross-device', name: 'Divergent online replay', code: '', custom: true }],
    customPatternRevisions: {},
  });
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' }), { timeout: 7000 }).toBeVisible();
});

test('Keep both pre-reserves IDs and names and preserves revision-only divergence', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  const current = { id: 'custom-a', name: 'A', code: 'return rgb(1, 1, 1);', custom: true };
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [current],
    customPatternRevisions: { 'custom-a': [{ ...current, code: 'return rgb(1, 0, 0);' }] },
  });
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await page.evaluate(async value => {
    const { readWorkspaceAssets, writeWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    const snapshot = readWorkspaceAssets();
    snapshot.customPatterns.push({ id: 'custom-a_local_copy', name: 'A (local copy)', code: '', custom: true });
    snapshot.customPatternRevisions['custom-a'] = [{ ...value, code: 'return rgb(0, 1, 0);' }];
    writeWorkspaceAssets(snapshot, undefined, { dispatch: false });
  }, current);
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [current],
    customPatternRevisions: { 'custom-a': [{ ...current, code: 'return rgb(0, 0, 1);' }] },
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const conflict = page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Keep both copies' }).click();
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns.length).toBe(3);
  const value = fixture.assets.get('custom-patterns')!.value;
  expect(value.customPatterns.map((pattern: any) => pattern.id).sort())
    .toEqual(['custom-a', 'custom-a_local_copy', 'custom-a_local_copy_2']);
  expect(value.customPatterns.map((pattern: any) => pattern.name).sort())
    .toEqual(['A', 'A (local copy 2)', 'A (local copy)']);
  expect(value.customPatternRevisions['custom-a_local_copy_2'][0].code).toBe('return rgb(0, 1, 0);');
});

test('Keep both preserves a remote tombstone history and copies a stale local recreation', async ({ page, browser }) => {
  const fixture = new LibraryFixture('worker');
  const original = { id: 'custom-tombstone', name: 'Tombstone glow', code: 'return rgb(1, 0, 0);', custom: true };
  const remoteHistory = [{ ...original, name: 'Remote archived glow', code: 'return rgb(0.5, 0, 0);' }];
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [original],
    customPatternRevisions: { 'custom-tombstone': remoteHistory },
  });
  await fixture.install(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');

  const stale = await freshWorkspacePage(browser, fixture);
  try {
    await expect.poll(() => stale.page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
    await page.evaluate(async () => {
      const { deleteCustomPattern } = await import('/src/lib/customPatterns.js');
      deleteCustomPattern('custom-tombstone');
    });
    await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns.length).toBe(0);
    expect(fixture.assets.get('custom-patterns')?.value.customPatternRevisions['custom-tombstone']).toEqual(remoteHistory);

    await stale.page.evaluate(async () => {
      const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
      updateCustomPattern('custom-tombstone', {
        name: 'Stale local recreation',
        code: 'return rgb(0, 1, 0);',
      });
    });
    const conflict = stale.page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' });
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Keep both copies' }).click();

    await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns.length).toBe(1);
    const value = fixture.assets.get('custom-patterns')!.value;
    expect(value.customPatterns[0]).toMatchObject({
      id: 'custom-tombstone_local_copy',
      name: 'Stale local recreation (local copy)',
    });
    expect(value.customPatternRevisions['custom-tombstone']).toEqual(remoteHistory);
    expect(value.customPatternRevisions['custom-tombstone_local_copy']).toHaveLength(2);
    expect(value.customPatternRevisions['custom-tombstone_local_copy'].every((revision: any) => (
      revision.id === 'custom-tombstone_local_copy'
      && revision.name === 'Stale local recreation (local copy)'
    ))).toBe(true);
  } finally {
    await stale.context.close();
  }
});

test('fresh Patterns resolves a project selection that exists only in cloud custom patterns', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{
      id: 'custom-cloud-only',
      name: 'Cloud-only cyan',
      code: 'return rgb(0, 1, 1);',
      custom: true,
    }],
    customPatternRevisions: {},
  });
  const project = portable('Cloud pattern project', 'lwproj-cloud-pattern');
  project.pattern.activePatternId = 'custom-cloud-only';
  await page.addInitScript(savedProject => {
    localStorage.setItem('lw_autosave_v3', JSON.stringify(savedProject));
  }, project);
  await fixture.install(page);
  await page.goto('/#screen=patterns', { waitUntil: 'domcontentloaded' });

  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await expect(page.locator('.pm-cards .pmcard[data-pattern-id="custom-cloud-only"]')).toHaveClass(/\bon\b/);
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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');
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
  await expect(page.getByTestId('cloud-sync-status')).toHaveText('Saved online');

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
  const workerArchive = worker.seed('Archived work', { archived: true });
  await worker.install(page);
  await openLibrary(page);
  await page.getByRole('button', { name: 'Archived projects' }).click();
  await expect(page.getByRole('button', { name: 'Delete permanently' })).toHaveCount(0);
  const workerDeleteStatus = await page.evaluate(async id => fetch(`/api/library/projects/${id}`, { method: 'DELETE' }).then(response => response.status), workerArchive.id);
  expect(workerDeleteStatus).toBe(403);

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
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-backed-up', name: 'Backed up glow', code: 'return rgb(1, 1, 1);', custom: true }],
    customPatternRevisions: {},
  });
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
    workspaceAssets: [{
      kind: 'custom-patterns',
      currentRevision: 1,
      revisions: [{
        revision: 1,
        createdAt: '2026-08-01T10:00:00.000Z',
        value: {
          version: 1,
          customPatterns: [{ id: 'custom-restored', name: 'Restored glow', code: 'return rgb(0, 1, 1);', custom: true }],
          customPatternRevisions: {},
        },
      }],
    }],
  }));
  await page.setInputFiles('[data-testid="cloud-master-restore"]', restorePath);
  await expect(page.getByText('Restored 1 project and 1 workspace asset')).toBeVisible();
  await expect(page.getByText('Backup project (restored)', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('Restored glow');

  const oversizedProjectPath = path.join(temp, 'oversized.lw.json');
  fs.writeFileSync(oversizedProjectPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  await page.setInputFiles('[data-testid="cloud-project-import"]', oversizedProjectPath);
  await expect(page.getByText('Project files must be 2 MB or smaller.')).toBeVisible();

  const oversizedBackupPath = path.join(temp, 'oversized.lw-library.json');
  fs.writeFileSync(oversizedBackupPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  await page.setInputFiles('[data-testid="cloud-master-restore"]', oversizedBackupPath);
  await expect(page.getByText('Master backups must be 8 MB or smaller.')).toBeVisible();
});

test('reports a master restore failure when refreshed assets cannot be read and preserves valid local assets', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-valid-local', name: 'Valid local glow', code: '', custom: true }],
    customPatternRevisions: {},
  });
  await fixture.install(page);
  await openLibrary(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await expect(page.getByText('owner@example.test').first()).toBeVisible();

  const restorePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-restore-failure-')), 'restore.lw-library.json');
  fs.writeFileSync(restorePath, JSON.stringify({
    format: 'lightweaver.library-backup',
    version: 1,
    exportedAt: '2026-08-01T10:00:00.000Z',
    projects: [],
    workspaceAssets: [{
      kind: 'custom-patterns',
      currentRevision: 1,
      revisions: [{
        revision: 1,
        createdAt: '2026-08-01T10:00:00.000Z',
        value: {
          version: 1,
          customPatterns: [{ id: 'custom-restored-failure', name: 'Should not replace local', code: '', custom: true }],
          customPatternRevisions: {},
        },
      }],
    }],
  }));
  fixture.assetReadFailures.push(503, 503);
  await page.setInputFiles('[data-testid="cloud-master-restore"]', restorePath);

  await expect(page.getByText('Fixture asset read failure 503.')).toBeVisible();
  expect(await page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('Valid local glow');
  await expect(page.getByText(/Restored \d+ projects? and \d+ workspace assets?/)).toHaveCount(0);
});

test('a master restore supersedes a committed PUT whose success response arrives late', async ({ page }) => {
  const fixture = new LibraryFixture('owner');
  fixture.seedAsset('custom-patterns', {
    version: 1,
    customPatterns: [{ id: 'custom-epoch', name: 'Epoch base', code: 'return rgb(1, 0, 0);', custom: true }],
    customPatternRevisions: {},
  });
  await fixture.install(page);
  await openLibrary(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.workspaceAssetsReady || '')).toBe('true');
  await expect(page.getByText('owner@example.test').first()).toBeVisible();

  fixture.holdNextAssetSuccessResponse();
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-epoch', { name: 'Committed before restore' });
  });
  await fixture.delayedAssetSuccessStarted;
  expect(fixture.assets.get('custom-patterns')?.revision).toBe(2);

  const restorePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-restore-epoch-')), 'restore.lw-library.json');
  fs.writeFileSync(restorePath, JSON.stringify({
    format: 'lightweaver.library-backup',
    version: 1,
    exportedAt: '2026-08-01T10:00:00.000Z',
    projects: [],
    workspaceAssets: [{
      kind: 'custom-patterns',
      currentRevision: 1,
      revisions: [{
        revision: 1,
        createdAt: '2026-08-01T10:00:00.000Z',
        value: {
          version: 1,
          customPatterns: [{ id: 'custom-epoch', name: 'Restore wins', code: 'return rgb(0, 0, 1);', custom: true }],
          customPatternRevisions: {},
        },
      }],
    }],
  }));
  await page.setInputFiles('[data-testid="cloud-master-restore"]', restorePath);
  await expect.poll(() => page.evaluate(async () => {
    const { readWorkspaceAssets } = await import('/src/lib/workspaceAssets.js');
    return readWorkspaceAssets().customPatterns[0]?.name || '';
  })).toBe('Restore wins');
  expect(fixture.assets.get('custom-patterns')?.revision).toBe(3);

  fixture.releaseAssetSuccessResponse();
  await expect.poll(() => page.evaluate(() => (
    JSON.parse(localStorage.getItem('lw_cloud_workspace_asset_heads_v1') || '{}')['custom-patterns']?.revision
  ))).toBe(3);

  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const { updateCustomPattern } = await import('/src/lib/customPatterns.js');
    updateCustomPattern('custom-epoch', { name: 'Edit after restore' });
  });
  await expect.poll(() => fixture.assets.get('custom-patterns')?.value.customPatterns[0]?.name).toBe('Edit after restore');
  await expect(page.getByRole('alert').filter({ hasText: 'Workspace patterns changed on another device' })).toHaveCount(0);
});
