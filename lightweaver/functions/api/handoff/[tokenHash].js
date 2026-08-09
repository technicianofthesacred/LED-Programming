import { resolveHandoffStore, validateTokenHash } from './_shared/store.js';

const responseHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: responseHeaders });

export async function onRequestGet({ params, env }) {
  let tokenHash;
  try {
    tokenHash = validateTokenHash(String(params?.tokenHash || ''));
  } catch {
    return json(400, { error: 'invalid-token-hash' });
  }
  const record = await resolveHandoffStore(env).consume(tokenHash);
  if (!record) return json(404, { error: 'handoff-not-found' });
  if (record.expired) return json(410, { error: 'handoff-expired' });
  return json(200, { iv: record.iv, ciphertext: record.ciphertext, expiresAt: record.expiresAt });
}

export function onRequest() {
  return json(405, { error: 'method-not-allowed' });
}
