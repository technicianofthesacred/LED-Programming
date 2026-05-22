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

export async function requestAiPatternDraft(payload, {
  fetchImpl = globalThis.fetch,
  token = getStoredAiPatternToken(),
} = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-lightweaver-ai-token'] = token;
  const response = await fetchImpl('/api/ai/pattern', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `AI request failed with HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code || 'request_failed';
    error.data = data;
    throw error;
  }
  return data.draft;
}
