const TABLE = 'lightweaver_handoff_stage';

export const HANDOFF_MAX_CIPHERTEXT_BYTES = 2 * 1024 * 1024;
export const HANDOFF_MAX_TTL_MS = 10 * 60 * 1000;

function encodedBytes(value) {
  return Buffer.from(value, 'base64url').byteLength;
}

export function validateTokenHash(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value || '') || encodedBytes(value) !== 32) throw new Error('invalid-token-hash');
  return value;
}

export function validateStagedCiphertext(value, { now = Date.now() } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-stage');
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'ciphertext,expiresAt,iv,tokenHash') throw new Error('ciphertext-only');
  const tokenHash = validateTokenHash(value.tokenHash);
  if (!/^[A-Za-z0-9_-]{16}$/.test(value.iv || '') || encodedBytes(value.iv) !== 12) throw new Error('invalid-iv');
  if (!/^[A-Za-z0-9_-]+$/.test(value.ciphertext || '')) throw new Error('invalid-ciphertext');
  const ciphertext = Buffer.from(value.ciphertext, 'base64url');
  if (ciphertext.byteLength < 32) throw new Error('invalid-ciphertext');
  if (ciphertext.byteLength > HANDOFF_MAX_CIPHERTEXT_BYTES) throw new Error('too-large');
  const decodedPrefix = ciphertext.subarray(0, Math.min(ciphertext.byteLength, 4096)).toString('utf8').trimStart();
  if (decodedPrefix.startsWith('{') || decodedPrefix.startsWith('[') || /"(?:project|artwork|layout|patterns?)"\s*:/i.test(decodedPrefix)) {
    throw new Error('plaintext-project-rejected');
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + HANDOFF_MAX_TTL_MS) throw new Error('invalid-expiry');
  return Object.freeze({ tokenHash, iv: value.iv, ciphertext: value.ciphertext, expiresAt: value.expiresAt });
}

async function ensureD1(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (token_hash TEXT PRIMARY KEY, iv TEXT NOT NULL, ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`).run();
}

export function createD1HandoffStore(db, { now = () => Date.now() } = {}) {
  if (!db?.prepare) throw new Error('HANDOFF_STORE or PROJECTS_DB binding is required');
  return {
    async stage(record) {
      await ensureD1(db);
      try {
        await db.prepare(`INSERT INTO ${TABLE} (token_hash, iv, ciphertext, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
          .bind(record.tokenHash, record.iv, record.ciphertext, record.expiresAt, now()).run();
        return true;
      } catch (error) {
        if (/unique|constraint/i.test(String(error?.message || error))) return false;
        throw error;
      }
    },
    async consume(tokenHash) {
      await ensureD1(db);
      const row = await db.prepare(`DELETE FROM ${TABLE} WHERE token_hash = ? RETURNING iv, ciphertext, expires_at AS expiresAt`)
        .bind(tokenHash).first();
      if (!row) return null;
      return { iv: row.iv, ciphertext: row.ciphertext, expiresAt: Number(row.expiresAt), expired: Number(row.expiresAt) <= now() };
    },
  };
}

export function createMemoryHandoffStore({ now = () => Date.now() } = {}) {
  const records = new Map();
  let lock = Promise.resolve();
  const exclusive = operation => {
    const result = lock.then(operation, operation);
    lock = result.catch(() => {});
    return result;
  };
  return {
    stage: record => exclusive(() => {
      if (records.has(record.tokenHash)) return false;
      records.set(record.tokenHash, structuredClone(record));
      return true;
    }),
    consume: tokenHash => exclusive(() => {
      const record = records.get(tokenHash);
      if (!record) return null;
      records.delete(tokenHash);
      return { iv: record.iv, ciphertext: record.ciphertext, expiresAt: record.expiresAt, expired: record.expiresAt <= now() };
    }),
  };
}

export function resolveHandoffStore(env) {
  return env?.HANDOFF_STORE || createD1HandoffStore(env?.PROJECTS_DB);
}
