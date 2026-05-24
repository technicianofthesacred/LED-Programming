import express from 'express';
import OpenAI from 'openai';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

export const AI_PATTERN_TIMEOUT_MS = 30000;
export const AI_PATTERN_CODE_MAX_LENGTH = 4000;
export const AI_PATTERN_MAX_PARAMS = 32;
export const AI_PATTERN_PARAM_KEY_MAX_LENGTH = 48;
export const AI_PATTERN_PARAM_STRING_MAX_LENGTH = 120;
export const AI_PATTERN_RATE_LIMIT = 20;
export const AI_PATTERN_RATE_WINDOW_MS = 10 * 60 * 1000;

export const AI_PATTERN_PROVIDERS = ['openai', 'anthropic', 'openrouter'];
export const AI_PATTERN_PROVIDER_DETAILS = [
  { id: 'openai', label: 'ChatGPT', detail: 'OpenAI', keyEnv: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Claude', detail: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', detail: 'model router', keyEnv: 'OPENROUTER_API_KEY' },
];

export const AiPatternDraftSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(220),
  changeSummary: z.array(z.string().min(1).max(140)).min(1).max(6),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(8),
  code: z.string().min(1).max(AI_PATTERN_CODE_MAX_LENGTH),
  suggestedParams: z
    .array(
      z.object({
        name: z.string().min(1).max(48).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        value: z.number(),
      })
    )
    .max(32),
  notes: z.string().max(600),
});

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_PROVIDER_MODELS = {
  openai: DEFAULT_MODEL,
  anthropic: 'claude-sonnet-4-20250514',
  openrouter: 'openai/gpt-5.1',
};

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return AI_PATTERN_PROVIDERS.includes(value) ? value : DEFAULT_PROVIDER;
}

function sanitizeParams(params) {
  const sanitized = {};
  let count = 0;

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(params)) {
    if (count >= AI_PATTERN_MAX_PARAMS) break;
    if (!key || key.length > AI_PATTERN_PARAM_KEY_MAX_LENGTH) continue;

    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
      count += 1;
    } else if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      if (typeof value === 'string' && value.length > AI_PATTERN_PARAM_STRING_MAX_LENGTH) continue;
      sanitized[key] = value;
      count += 1;
    }
  }

  return sanitized;
}

function getRateLimitConfig(env) {
  const limit = Number.parseInt(env.AI_PATTERN_RATE_LIMIT || '', 10);
  const windowMs = Number.parseInt(env.AI_PATTERN_RATE_WINDOW_MS || '', 10);

  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : AI_PATTERN_RATE_LIMIT,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : AI_PATTERN_RATE_WINDOW_MS,
  };
}

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function hasValidAuthToken(req, env) {
  const expectedToken = env.AI_PATTERN_AUTH_TOKEN;
  if (!expectedToken) return true;

  const authorization = req.get('authorization') || '';
  const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  const headerToken = req.get('x-lightweaver-ai-token') || '';

  return bearerToken === expectedToken || headerToken === expectedToken;
}

function isRateLimited(req, rateLimitStore, env, now = Date.now()) {
  const { limit, windowMs } = getRateLimitConfig(env);
  const ip = getClientIp(req);
  const entry = rateLimitStore.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }

  if (entry.count >= limit) {
    return true;
  }

  entry.count += 1;
  return false;
}

function sanitizePatternForProvider(pattern) {
  if (!pattern) return null;

  return {
    id: pattern.id || '',
    name: pattern.name || '',
    description: pattern.description || pattern.desc || '',
    code: pattern.code || '',
    palette: Array.isArray(pattern.palette) ? pattern.palette : [],
    params: sanitizeParams(pattern.params),
    isCustom: !!pattern.isCustom,
  };
}

const PatternPayloadSchema = z
  .object({
    id: z.string().max(120).optional().default(''),
    name: z.string().max(120).optional().default(''),
    description: z.string().max(600).optional(),
    desc: z.string().max(600).optional(),
    code: z.string().max(6000).optional().default(''),
    palette: z.array(z.string().max(32)).max(16).optional().default([]),
    params: z.record(z.string(), z.unknown()).optional().default({}),
    isCustom: z.boolean().optional().default(false),
  })
  .passthrough();

const AiPatternRequestSchema = z.object({
  provider: z.enum(AI_PATTERN_PROVIDERS).optional(),
  mode: z.enum(['generate', 'transform', 'refine']).optional().default('transform'),
  instruction: z.string().trim().min(1).max(1000),
  sourcePattern: PatternPayloadSchema.optional().default({}),
  draftPattern: PatternPayloadSchema.nullable().optional().default(null),
  projectContext: z
    .object({
      ledCount: z.coerce.number().int().min(0).max(100000).optional().default(0),
      stripCount: z.coerce.number().int().min(0).max(1000).optional().default(0),
      hasAudio: z.boolean().optional().default(false),
      hasMappedXY: z.boolean().optional().default(true),
    })
    .optional()
    .default({}),
});

const AiProviderSettingsSchema = z.object({
  provider: z.enum(AI_PATTERN_PROVIDERS).optional(),
  keys: z
    .object({
      openai: z.string().trim().max(400).optional(),
      anthropic: z.string().trim().max(400).optional(),
      openrouter: z.string().trim().max(400).optional(),
    })
    .optional()
    .default({}),
  clearKeys: z.array(z.enum(AI_PATTERN_PROVIDERS)).optional().default([]),
});

const OpenRouterOAuthStartSchema = z.object({
  returnTo: z.string().trim().max(1000).optional(),
});

export function getAiPatternProvider(env = process.env, requestedProvider = null) {
  return normalizeProvider(requestedProvider || env.AI_PATTERN_PROVIDER || DEFAULT_PROVIDER);
}

export function getAiPatternModel(env = process.env, provider = getAiPatternProvider(env)) {
  const normalizedProvider = normalizeProvider(provider);
  const providerKey = `AI_PATTERN_${normalizedProvider.toUpperCase()}_MODEL`;
  return env[providerKey] || env.AI_PATTERN_MODEL || DEFAULT_PROVIDER_MODELS[normalizedProvider] || DEFAULT_MODEL;
}

async function readAiSettings(settingsPath) {
  if (!settingsPath) return {};
  try {
    const text = await readFile(settingsPath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw Object.assign(new Error('AI provider settings could not be read.'), {
      status: 500,
      code: 'ai_settings_unreadable',
    });
  }
}

function normalizeSavedSettings(settings = {}) {
  const keys = settings.keys && typeof settings.keys === 'object' && !Array.isArray(settings.keys)
    ? settings.keys
    : {};
  const provider = String(settings.provider || '').trim().toLowerCase();
  return {
    provider: AI_PATTERN_PROVIDERS.includes(provider) ? provider : '',
    keys: Object.fromEntries(
      AI_PATTERN_PROVIDERS
        .map(provider => [provider, typeof keys[provider] === 'string' ? keys[provider].trim() : ''])
        .filter(([, value]) => value)
    ),
    updatedAt: typeof settings.updatedAt === 'string' ? settings.updatedAt : '',
  };
}

function buildEffectiveEnv(env, savedSettings) {
  const normalized = normalizeSavedSettings(savedSettings);
  const merged = { ...env };
  if (normalized.provider) merged.AI_PATTERN_PROVIDER = normalized.provider;
  if (normalized.keys.openai) merged.OPENAI_API_KEY = normalized.keys.openai;
  if (normalized.keys.anthropic) merged.ANTHROPIC_API_KEY = normalized.keys.anthropic;
  if (normalized.keys.openrouter) merged.OPENROUTER_API_KEY = normalized.keys.openrouter;
  return merged;
}

async function getEffectiveAiEnv(env, settingsPath) {
  const savedSettings = await readAiSettings(settingsPath);
  return buildEffectiveEnv(env, savedSettings);
}

function getAiSettingsStatus(env, savedSettings = {}) {
  const effectiveEnv = buildEffectiveEnv(env, savedSettings);
  const provider = getAiPatternProvider(effectiveEnv);
  return {
    provider,
    providers: AI_PATTERN_PROVIDER_DETAILS.map(detail => ({
      ...detail,
      configured: !!effectiveEnv[detail.keyEnv],
      source: savedSettings.keys?.[detail.id] ? 'saved' : env[detail.keyEnv] ? 'environment' : 'missing',
      model: getAiPatternModel(effectiveEnv, detail.id),
    })),
  };
}

async function writeAiSettings(settingsPath, settings) {
  if (!settingsPath) {
    throw Object.assign(new Error('AI provider settings path is not configured.'), {
      status: 500,
      code: 'ai_settings_unwritable',
    });
  }
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

async function saveAiSettings(env, settingsPath, payload) {
  const parsed = AiProviderSettingsSchema.safeParse(payload || {});
  if (!parsed.success) {
    throw Object.assign(new Error('AI provider settings are invalid.'), {
      status: 400,
      code: 'invalid_settings',
      issues: parsed.error.issues,
    });
  }

  const current = normalizeSavedSettings(await readAiSettings(settingsPath));
  const next = {
    provider: normalizeProvider(parsed.data.provider || current.provider || env.AI_PATTERN_PROVIDER),
    keys: { ...current.keys },
    updatedAt: new Date().toISOString(),
  };

  for (const provider of parsed.data.clearKeys) {
    delete next.keys[provider];
  }

  for (const provider of AI_PATTERN_PROVIDERS) {
    const value = parsed.data.keys?.[provider];
    if (typeof value === 'string' && value.trim()) {
      next.keys[provider] = value.trim();
    }
  }

  await writeAiSettings(settingsPath, next);
  return getAiSettingsStatus(env, next);
}

function createCodeVerifier() {
  return randomBytes(32).toString('base64url');
}

function createCodeChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function getRequestOrigin(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function getConnectedReturnTo(req, returnTo) {
  const origin = getRequestOrigin(req);
  let url;
  try {
    url = returnTo ? new URL(returnTo, origin) : new URL('/#screen=pattern', origin);
  } catch {
    url = new URL('/#screen=pattern', origin);
  }
  if (url.origin !== origin) {
    url = new URL('/#screen=pattern', origin);
  }
  const hashParams = new URLSearchParams((url.hash || '#screen=pattern').slice(1));
  if (!hashParams.get('screen')) hashParams.set('screen', 'pattern');
  hashParams.set('aiSetup', 'connected');
  url.hash = hashParams.toString();
  return url.toString();
}

function createOpenRouterAuthorizationUrl(req, { state, codeChallenge }) {
  const callbackUrl = new URL('/api/ai/openrouter/oauth/callback', getRequestOrigin(req));
  callbackUrl.searchParams.set('state', state);

  const authorizationUrl = new URL('https://openrouter.ai/auth');
  authorizationUrl.searchParams.set('callback_url', callbackUrl.toString());
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  return authorizationUrl.toString();
}

export function validateAiPatternRequest(payload) {
  return AiPatternRequestSchema.safeParse(payload || {});
}

export function buildAiPatternInput(payload) {
  const source = payload?.sourcePattern || {};
  const draft = payload?.draftPattern || null;
  const project = payload?.projectContext || {};
  const mode = payload?.mode || 'transform';
  const instruction = String(payload?.instruction || '').trim();

  return [
    {
      role: 'developer',
      content: [
        'You are the Lightweaver pattern draft generator.',
        'Return only a structured draft that matches the supplied schema.',
        'Generate JavaScript function-body code for the existing Lightweaver per-pixel pattern runtime.',
        'Allowed inputs: index, x, y, t, time, pixelCount, palette, beat, beatSin, params, stripId, stripProgress, bass, mid, hi.',
        'Allowed helpers: hsv, rgb, wave, triangle, square, clamp, lerp, fract, abs, floor, ceil, int, float, min, max, pow, sqrt, exp, log, tan, atan2, round, map, step, smoothstep, mix, mod, vec2, length, distance, sin, cos, noise, randomF, ping, easeIn, easeOut, easeInOut, norm, polar, fbm, samplePalette.',
        'Do not use browser APIs, network APIs, imports, eval, Function, document, window, localStorage, timers, or asynchronous code.',
        'Prefer editable code with clear @param annotations for user-facing controls.',
        'Return suggestedParams as an array of objects with name and value fields, for example [{ "name": "speed", "value": 0.25 }].',
        'Use palette-aware code when the prompt mentions colors.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        instruction,
        sourcePattern: sanitizePatternForProvider(source),
        draftPattern: sanitizePatternForProvider(draft),
        projectContext: {
          ledCount: project.ledCount || 0,
          stripCount: project.stripCount || 0,
          hasAudio: !!project.hasAudio,
          hasMappedXY: project.hasMappedXY !== false,
        },
      }),
    },
  ];
}

export function normalizeAiPatternDraft(draft) {
  const suggestedParams = {};

  for (const param of draft?.suggestedParams || []) {
    if (param && typeof param.name === 'string' && typeof param.value === 'number') {
      suggestedParams[param.name] = param.value;
    }
  }

  return { ...draft, suggestedParams, notes: draft?.notes || '' };
}

export function buildOpenRouterResponseFormat() {
  const format = zodTextFormat(AiPatternDraftSchema, 'lightweaver_pattern_draft');
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      strict: format.strict,
      schema: format.schema,
    },
  };
}

function stripJsonFence(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function parseAiPatternDraftText(text) {
  const stripped = stripJsonFence(text);
  const candidates = [stripped];
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }

  let parsed = null;
  let parseError = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      parseError = null;
      break;
    } catch (error) {
      parseError = error;
    }
  }

  if (!parsed) {
    throw Object.assign(new Error(parseError?.message || 'AI provider returned invalid JSON.'), {
      status: 502,
      code: 'invalid_provider_json',
    });
  }

  const result = AiPatternDraftSchema.safeParse(parsed);
  if (!result.success) {
    throw Object.assign(new Error('AI provider returned a draft that did not match the Lightweaver schema.'), {
      status: 502,
      code: 'invalid_provider_response',
      issues: result.error.issues,
    });
  }

  return normalizeAiPatternDraft(result.data);
}

function hasAiRefusal(value) {
  if (!value || typeof value !== 'object') return false;

  if (value.type === 'refusal') return true;
  if (typeof value.refusal === 'string' && value.refusal.trim()) return true;

  if (Array.isArray(value)) {
    return value.some((item) => hasAiRefusal(item));
  }

  return hasAiRefusal(value.output) || hasAiRefusal(value.content);
}

function isAiResponseIncomplete(response) {
  return response?.status === 'incomplete' || !!response?.incomplete_details;
}

export function normalizeAiProviderError(error) {
  if (error?.name === 'AbortError') {
    return { status: 504, code: 'timeout', message: 'AI request timed out.' };
  }
  if (error?.status === 429) {
    return { status: 429, code: 'rate_limited', message: 'AI provider rate limit reached.' };
  }
  if (error?.status === 401) {
    return { status: 401, code: 'unauthorized', message: 'AI provider rejected the API key.' };
  }
  return {
    status: error?.status || 502,
    code: error?.code || 'provider_error',
    message: error?.message || 'AI provider request failed.',
    issues: error?.issues,
  };
}

function getProviderApiKey(env, provider) {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY || '';
  if (provider === 'openrouter') return env.OPENROUTER_API_KEY || '';
  return env.OPENAI_API_KEY || '';
}

function missingApiKeyError(provider) {
  const envName = provider === 'anthropic'
    ? 'ANTHROPIC_API_KEY'
    : provider === 'openrouter'
      ? 'OPENROUTER_API_KEY'
      : 'OPENAI_API_KEY';
  return {
    status: 501,
    code: 'missing_api_key',
    message: `Set ${envName} on the Lightweaver server to enable ${provider} AI pattern creation.`,
  };
}

async function readProviderJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function postProviderJson(url, { headers, body, fetchImpl, timeoutMs = AI_PATTERN_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await readProviderJson(response);
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `AI provider request failed with HTTP ${response.status}.`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestOpenAiDraft({ env, client, createOpenAiClient, requestData }) {
  const openai = client || createOpenAiClient({ apiKey: env.OPENAI_API_KEY });
  const payload = {
    model: getAiPatternModel(env, 'openai'),
    input: buildAiPatternInput(requestData),
    text: {
      format: zodTextFormat(AiPatternDraftSchema, 'lightweaver_pattern_draft'),
    },
  };
  const response = await openai.responses.parse(payload, {
    timeout: AI_PATTERN_TIMEOUT_MS,
    maxRetries: 0,
  });

  if (hasAiRefusal(response)) {
    throw Object.assign(new Error('AI provider refused the pattern request.'), { status: 422, code: 'refused' });
  }

  if (isAiResponseIncomplete(response)) {
    throw Object.assign(new Error('AI provider returned an incomplete draft.'), { status: 502, code: 'incomplete' });
  }

  if (!response?.output_parsed) {
    throw Object.assign(new Error('AI provider returned an empty draft.'), { status: 502, code: 'empty_response' });
  }

  return normalizeAiPatternDraft(response.output_parsed);
}

function getProviderPromptParts(requestData) {
  const input = buildAiPatternInput(requestData);
  return {
    system: input[0].content,
    user: [
      input[1].content,
      'Return exactly one JSON object. Do not wrap it in Markdown.',
    ].join('\n\n'),
  };
}

async function requestAnthropicDraft({ env, fetchImpl, requestData }) {
  const { system, user } = getProviderPromptParts(requestData);
  const response = await postProviderJson('https://api.anthropic.com/v1/messages', {
    fetchImpl,
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': env.ANTHROPIC_VERSION || '2023-06-01',
    },
    body: {
      model: getAiPatternModel(env, 'anthropic'),
      max_tokens: Number.parseInt(env.AI_PATTERN_MAX_OUTPUT_TOKENS || '', 10) || 4096,
      system,
      messages: [{ role: 'user', content: user }],
    },
  });

  if (response?.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('Anthropic returned an incomplete draft.'), { status: 502, code: 'incomplete' });
  }

  const text = (response?.content || [])
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim();
  if (!text) {
    throw Object.assign(new Error('Anthropic returned an empty draft.'), { status: 502, code: 'empty_response' });
  }
  return parseAiPatternDraftText(text);
}

async function requestOpenRouterDraft({ env, fetchImpl, requestData }) {
  const { system, user } = getProviderPromptParts(requestData);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
  };
  if (env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;
  if (env.OPENROUTER_APP_NAME) headers['X-Title'] = env.OPENROUTER_APP_NAME;

  const response = await postProviderJson('https://openrouter.ai/api/v1/chat/completions', {
    fetchImpl,
    headers,
    body: {
      model: getAiPatternModel(env, 'openrouter'),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: buildOpenRouterResponseFormat(),
    },
  });

  const choice = response?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw Object.assign(new Error('OpenRouter returned an incomplete draft.'), { status: 502, code: 'incomplete' });
  }
  const content = choice?.message?.content;
  const text = Array.isArray(content)
    ? content.map(part => part?.text || '').join('\n')
    : String(content || '');
  if (!text.trim()) {
    throw Object.assign(new Error('OpenRouter returned an empty draft.'), { status: 502, code: 'empty_response' });
  }
  return parseAiPatternDraftText(text);
}

export function createAiPatternRouter({
  env = process.env,
  client = null,
  createOpenAiClient = (options) => new OpenAI(options),
  fetchImpl = globalThis.fetch,
  settingsPath = null,
  oauthStateStore = new Map(),
  rateLimitStore = new Map(),
  now = () => Date.now(),
} = {}) {
  const router = express.Router();

  router.get('/settings', async (req, res) => {
    if (!hasValidAuthToken(req, env)) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'AI pattern access is not authorized.',
        },
      });
    }

    try {
      const savedSettings = await readAiSettings(settingsPath);
      return res.json(getAiSettingsStatus(env, savedSettings));
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }
  });

  router.put('/settings', async (req, res) => {
    if (!hasValidAuthToken(req, env)) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'AI pattern access is not authorized.',
        },
      });
    }

    try {
      const status = await saveAiSettings(env, settingsPath, req.body || {});
      return res.json(status);
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }
  });

  router.post('/openrouter/oauth/start', async (req, res) => {
    if (!hasValidAuthToken(req, env)) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'AI pattern access is not authorized.',
        },
      });
    }

    const parsed = OpenRouterOAuthStartSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'invalid_oauth_start',
          message: 'OpenRouter account connection request is invalid.',
          issues: parsed.error.issues,
        },
      });
    }

    const state = randomBytes(18).toString('base64url');
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    oauthStateStore.set(state, {
      codeVerifier,
      returnTo: getConnectedReturnTo(req, parsed.data.returnTo),
      createdAt: Date.now(),
    });

    return res.json({
      authorizationUrl: createOpenRouterAuthorizationUrl(req, { state, codeChallenge }),
    });
  });

  router.get('/openrouter/oauth/callback', async (req, res) => {
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    const oauthState = oauthStateStore.get(state);
    oauthStateStore.delete(state);

    if (!state || !code || !oauthState) {
      return res.status(400).send('OpenRouter account connection could not be verified.');
    }

    try {
      const data = await postProviderJson('https://openrouter.ai/api/v1/auth/keys', {
        fetchImpl,
        headers: { 'content-type': 'application/json' },
        body: {
          code,
          code_verifier: oauthState.codeVerifier,
          code_challenge_method: 'S256',
        },
      });
      if (!data?.key || typeof data.key !== 'string') {
        throw Object.assign(new Error('OpenRouter did not return a usable account credential.'), {
          status: 502,
          code: 'invalid_openrouter_oauth_response',
        });
      }
      await saveAiSettings(env, settingsPath, {
        provider: 'openrouter',
        keys: { openrouter: data.key },
      });
      return res.redirect(oauthState.returnTo);
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).send(normalized.message);
    }
  });

  router.post('/pattern', async (req, res) => {
    const parsedRequest = validateAiPatternRequest(req.body || {});
    if (!parsedRequest.success) {
      return res.status(400).json({
        error: {
          code: 'invalid_request',
          message: 'AI pattern request is invalid.',
          issues: parsedRequest.error.issues,
        },
      });
    }

    if (!hasValidAuthToken(req, env)) {
      return res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'AI pattern access is not authorized.',
        },
      });
    }

    if (isRateLimited(req, rateLimitStore, env, now())) {
      return res.status(429).json({
        error: {
          code: 'rate_limited',
          message: 'AI pattern rate limit reached.',
        },
      });
    }

    let effectiveEnv = env;
    try {
      effectiveEnv = await getEffectiveAiEnv(env, settingsPath);
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }

    const provider = getAiPatternProvider(effectiveEnv, parsedRequest.data.provider);
    const apiKey = getProviderApiKey(effectiveEnv, provider);
    if (!apiKey && !(provider === 'openai' && client)) {
      const error = missingApiKeyError(provider);
      return res.status(error.status).json({ error });
    }

    try {
      const draft = provider === 'anthropic'
        ? await requestAnthropicDraft({ env: effectiveEnv, fetchImpl, requestData: parsedRequest.data })
        : provider === 'openrouter'
          ? await requestOpenRouterDraft({ env: effectiveEnv, fetchImpl, requestData: parsedRequest.data })
          : await requestOpenAiDraft({ env: effectiveEnv, client, createOpenAiClient, requestData: parsedRequest.data });
      return res.json({ draft });
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }
  });

  return router;
}
