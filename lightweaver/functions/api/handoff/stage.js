import { resolveHandoffStore, validateStagedCiphertext } from './_shared/store.js';

const responseHeaders = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: responseHeaders });

export async function onRequestPost({ request, env }) {
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return json(415, { error: 'json-required' });
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 2_900_000) return json(413, { error: 'too-large' });
  let input;
  try {
    input = await request.json();
  } catch {
    return json(400, { error: 'invalid-json' });
  }
  let record;
  try {
    record = validateStagedCiphertext(input);
  } catch (error) {
    return json(error.message === 'too-large' ? 413 : 400, { error: error.message });
  }
  const stored = await resolveHandoffStore(env).stage(record);
  return stored ? json(201, { staged: true, expiresAt: record.expiresAt }) : json(409, { error: 'token-already-staged' });
}

export function onRequest() {
  return json(405, { error: 'method-not-allowed' });
}
