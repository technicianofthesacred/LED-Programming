import { migrateProject, PROJECT_VERSION } from './projectModel.js';

export const PROJECT_ENVELOPE_SCHEMA_VERSION = 1;

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function canonicalProjectJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalProjectJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalProjectJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Small synchronous SHA-256 implementation keeps envelope validation usable in
// reducers, file import, IndexedDB transactions, and local HTTP adapters.
export function sha256Canonical(value) {
  const input = new TextEncoder().encode(canonicalProjectJson(value));
  const words = [];
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15];
      const b = words[index - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      [h,g,f,e,d,c,b,a] = [g,f,e,(d + t1) >>> 0,c,b,a,(t1 + t2) >>> 0];
    }
    hash = hash.map((value, index) => (value + [a,b,c,d,e,f,g,h][index]) >>> 0);
  }
  return hash.map(value => value.toString(16).padStart(8, '0')).join('');
}

export class ProjectHeadConflictError extends Error {
  constructor(currentHead = null) {
    super('Project head changed');
    this.name = 'ProjectHeadConflictError';
    this.code = 'head-conflict';
    this.currentHead = currentHead;
  }
}

export class ProjectRepositoryError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = 'ProjectRepositoryError';
    this.code = code;
  }
}

export function assertProjectPackage(project) {
  const migrated = migrateProject(structuredClone(project));
  if (!migrated || !migrated.id || !migrated.layout || !migrated.pattern || !migrated.show || !migrated.devices) {
    throw new ProjectRepositoryError('invalid-project', 'A complete editable Lightweaver project is required.');
  }
  return migrated;
}

function normalizeSource(source = {}) {
  const kind = ['browser', 'card', 'cloud', 'file', 'handoff'].includes(source?.kind) ? source.kind : 'browser';
  return {
    kind,
    ...(source?.cardId ? { cardId: String(source.cardId) } : {}),
    ...(source?.installationId ? { installationId: String(source.installationId) } : {}),
  };
}

export function createProjectEnvelope(project, {
  parentHash = null,
  localRevision = 1,
  modifiedAt = Date.now(),
  source = { kind: 'browser' },
} = {}) {
  const editableProject = assertProjectPackage(project);
  const envelope = {
    envelopeVersion: PROJECT_ENVELOPE_SCHEMA_VERSION,
    projectId: String(editableProject.id),
    projectSchemaVersion: Number(editableProject.version || PROJECT_VERSION),
    contentHash: sha256Canonical(editableProject),
    parentHash: parentHash === null ? null : String(parentHash),
    localRevision: Math.max(1, Number(localRevision) || 1),
    modifiedAt: Math.max(0, Number(modifiedAt) || 0),
    source: normalizeSource(source),
    project: editableProject,
  };
  return deepFreeze(structuredClone(envelope));
}

export function validateProjectEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectRepositoryError('invalid-envelope', 'Invalid project envelope.');
  const project = assertProjectPackage(value.project);
  if (Number(value.envelopeVersion) !== PROJECT_ENVELOPE_SCHEMA_VERSION
    || String(value.projectId || '') !== String(project.id)
    || Number(value.projectSchemaVersion) !== Number(project.version)
    || !/^[a-f0-9]{64}$/.test(String(value.contentHash || ''))
    || !Number.isSafeInteger(Number(value.localRevision))
    || Number(value.localRevision) < 1
    || (value.parentHash !== null && !/^[a-f0-9]{64}$/.test(String(value.parentHash || '')))) {
    throw new ProjectRepositoryError('invalid-envelope', 'Invalid project envelope metadata.');
  }
  if (sha256Canonical(project) !== value.contentHash) throw new ProjectRepositoryError('content-hash-mismatch', 'content-hash-mismatch: project content hash does not match.');
  return deepFreeze(structuredClone({ ...value, project, source: normalizeSource(value.source) }));
}

function sameExpectedHead(current, expectedHead) {
  return (current?.contentHash || null) === (expectedHead || null);
}

export function createMemoryProjectRepository(initial = []) {
  const projects = new Map(initial.map(value => {
    const valid = validateProjectEnvelope(value);
    return [valid.projectId, valid];
  }));
  const listeners = new Set();
  const notify = event => listeners.forEach(listener => { try { listener(event); } catch { /* isolated */ } });
  return Object.freeze({
    source: Object.freeze({ kind: 'browser', label: 'This browser' }),
    async list() { return [...projects.values()].sort((a, b) => b.modifiedAt - a.modifiedAt); },
    async read(projectId) { return projects.get(String(projectId)) || null; },
    async save(envelope, expectedHead = null) {
      const valid = validateProjectEnvelope(envelope);
      const current = projects.get(valid.projectId) || null;
      if (!sameExpectedHead(current, expectedHead)) throw new ProjectHeadConflictError(current);
      if (valid.parentHash !== (expectedHead || null)) throw new ProjectHeadConflictError(current);
      projects.set(valid.projectId, valid);
      notify({ type: 'save', projectId: valid.projectId, envelope: valid });
      return valid;
    },
    async remove(projectId, expectedHead = null) {
      const id = String(projectId);
      const current = projects.get(id) || null;
      if (!sameExpectedHead(current, expectedHead)) throw new ProjectHeadConflictError(current);
      projects.delete(id);
      notify({ type: 'remove', projectId: id, previous: current });
      return true;
    },
    watch(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  });
}
