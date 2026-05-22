import express from 'express';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';

export const AiPatternDraftSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(220),
  changeSummary: z.array(z.string().min(1).max(140)).min(1).max(6),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(8),
  code: z.string().min(1).max(6000),
  suggestedParams: z.record(z.number()).optional().default({}),
  notes: z.string().max(600).optional().default(''),
});

const DEFAULT_MODEL = 'gpt-5.4-mini';

export function getAiPatternModel(env = process.env) {
  return env.AI_PATTERN_MODEL || DEFAULT_MODEL;
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
        'Use palette-aware code when the prompt mentions colors.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        mode,
        instruction,
        sourcePattern: {
          id: source.id || '',
          name: source.name || '',
          description: source.description || source.desc || '',
          code: source.code || '',
          palette: Array.isArray(source.palette) ? source.palette : [],
          params: source.params || {},
          isCustom: !!source.isCustom,
        },
        draftPattern: draft,
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

export function createAiPatternRouter({ env = process.env, client = null } = {}) {
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

    try {
      const openai = client || new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const response = await openai.responses.parse({
        model: getAiPatternModel(env),
        input: buildAiPatternInput(req.body || {}),
        text: {
          format: zodTextFormat(AiPatternDraftSchema, 'lightweaver_pattern_draft'),
        },
      });
      return res.json({ draft: response.output_parsed });
    } catch (error) {
      const normalized = normalizeAiProviderError(error);
      return res.status(normalized.status).json({ error: normalized });
    }
  });

  return router;
}
