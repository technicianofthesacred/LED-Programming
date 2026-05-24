export const AI_PATTERN_TOKEN_STORAGE_KEY = 'lw_ai_pattern_token';

function getStoredAiPatternToken() {
  if (typeof globalThis.LIGHTWEAVER_AI_TOKEN === 'string') {
    return globalThis.LIGHTWEAVER_AI_TOKEN.trim();
  }
  try {
    return globalThis.localStorage?.getItem(AI_PATTERN_TOKEN_STORAGE_KEY)?.trim() || '';
  } catch {
    return '';
  }
}

function buildAiHeaders(token = getStoredAiPatternToken()) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-lightweaver-ai-token'] = token;
  return headers;
}

async function readAiJsonResponse(response, fallbackMessage) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || fallbackMessage || `AI request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || 'request_failed';
    error.data = data;
    throw error;
  }
  return data;
}

export async function requestAiPatternDraft(payload, {
  fetchImpl = globalThis.fetch,
  token = getStoredAiPatternToken(),
} = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const response = await fetchImpl('/api/ai/pattern', {
    method: 'POST',
    headers: buildAiHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await readAiJsonResponse(response);
  return data.draft;
}

export async function requestAiProviderSettings({
  fetchImpl = globalThis.fetch,
  token = getStoredAiPatternToken(),
} = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const response = await fetchImpl('/api/ai/settings', {
    method: 'GET',
    headers: buildAiHeaders(token),
  });
  return readAiJsonResponse(response, `AI settings request failed with HTTP ${response.status}`);
}

export async function saveAiProviderSettings(payload, {
  fetchImpl = globalThis.fetch,
  token = getStoredAiPatternToken(),
} = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const response = await fetchImpl('/api/ai/settings', {
    method: 'PUT',
    headers: buildAiHeaders(token),
    body: JSON.stringify(payload),
  });
  return readAiJsonResponse(response, `AI settings save failed with HTTP ${response.status}`);
}
