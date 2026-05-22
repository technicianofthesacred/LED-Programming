export async function requestAiPatternDraft(payload, { fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new Error('fetch is not available');
  const response = await fetchImpl('/api/ai/pattern', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
