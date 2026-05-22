import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

export const AI_PATTERN_TIMEOUT_MS = 30000;

export const AiPatternDraftSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(220),
  changeSummary: z.array(z.string().min(1).max(140)).min(1).max(6),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(8),
  code: z.string().min(1).max(6000),
  suggestedParams: z
    .array(
      z.object({
        name: z.string().min(1).max(48).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        value: z.number(),
      })
    )
    .max(32)
    .optional()
    .default([]),
  notes: z.string().max(600).optional().default(''),
});

const DEFAULT_MODEL = 'gpt-5.4-mini';

function sanitizeParams(params) {
  const sanitized = {};

  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value;
    }
  }

  return sanitized;
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

export function getAiPatternModel(env = process.env) {
  return env.AI_PATTERN_MODEL || DEFAULT_MODEL;
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

  return { ...draft, suggestedParams };
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
    code: 'provider_error',
    message: error?.message || 'AI provider request failed.',
  };
}

export function createAiPatternRouter({
  env = process.env,
  client = null,
  createOpenAiClient = (options) => new OpenAI(options),
} = {}) {
  const router = express.Router();

  router.post('/pattern', async (req, res) => {
    if (!env.OPENAI_API_KEY && !client) {
      return res.status(501).json({
        error: {
          code: 'missing_api_key',
          message: 'Set OPENAI_API_KEY on the Lightweaver server to enable AI pattern creation.',
        },
      });
    }

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

    try {
      const openai = client || createOpenAiClient({ apiKey: env.OPENAI_API_KEY });
      const payload = {
        model: getAiPatternModel(env),
        input: buildAiPatternInput(parsedRequest.data),
        text: {
          format: zodTextFormat(AiPatternDraftSchema, 'lightweaver_pattern_draft'),
        },
      };
      const response = await openai.responses.parse(payload, {
        timeout: AI_PATTERN_TIMEOUT_MS,
        maxRetries: 0,
      });

      if (hasAiRefusal(response)) {
        return res.status(422).json({
          error: {
            status: 422,
            code: 'refused',
            message: 'AI provider refused the pattern request.',
          },
        });
      }

      if (isAiResponseIncomplete(response)) {
        return res.status(502).json({
          error: {
            status: 502,
            code: 'incomplete',
            message: 'AI provider returned an incomplete draft.',
          },
        });
      }

      if (!response?.output_parsed) {
        return res.status(502).json({
          error: {
            status: 502,
            code: 'empty_response',
            message: 'AI provider returned an empty draft.',
          },
        });
      }

      return res.json({ draft: normalizeAiPatternDraft(response.output_parsed) });
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }
  });

  return router;
}
