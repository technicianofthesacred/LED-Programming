# AI Pattern Creator Design

Date: 2026-05-22
Project: Lightweaver
Status: Approved for implementation planning

## Summary

Lightweaver should add an AI Pattern Creator as an assistant drawer inside the existing pattern workflow. The assistant lets the user describe a new LED effect or transform any selected pattern with natural language, including follow-up edits like "slower", "smoother", "more blue", or "less sparkly".

The feature should support both no-code creation and easy code editing. AI outputs become draft patterns first. The current live pattern is not changed until the user accepts the draft.

## Goals

- Let the user generate a Lightweaver pattern from a natural-language prompt.
- Let the user transform any selected pattern, including built-in and custom patterns.
- Support iterative conversational refinement against the current draft.
- Keep generated code visible and editable for advanced users.
- Keep the main experience no-code, with preview, palette, parameter knobs, and accept/retry actions.
- Protect built-in patterns from direct modification.
- Validate AI output before it can be accepted or streamed to hardware.

## Non-Goals

- Do not generate WLED firmware effects or modify WLED firmware.
- Do not send arbitrary AI-generated code directly to WLED.
- Do not require hardware connection to use the creator.
- Do not build a full separate AI Studio in the first implementation.
- Do not make accepted AI changes overwrite built-in library definitions.

## Approved Decisions

- Entry point: an assistant drawer beside the existing pattern preview/code area.
- AI result behavior: draft-only until the user accepts.
- Persistence behavior: built-in pattern transforms save as new custom patterns; existing custom patterns update in place.
- Generation contract: AI returns structured pattern JSON, not loose text.
- Refinement model: each follow-up instruction uses the current draft when present, otherwise the selected pattern.
- Implementation target: computer/local browser first, then the same server path can run on the Raspberry Pi.

## User Experience

The assistant drawer appears in the pattern screen. It is scoped to the selected pattern and shows the current transformation target, for example "Transforming: Aurora".

The drawer has:

- A conversational input for prompts and follow-up edits.
- A message history with user instructions and assistant summaries.
- A draft card when an AI response succeeds.
- Draft actions: Accept, Compare, Retry, Edit draft code.
- Error actions: Retry, Simplify, Show raw response.

The central preview continues to show the current accepted pattern. The draft card shows a draft preview and summary. The user can compare the draft against the current accepted pattern before accepting.

### Typical Flow

1. User selects `Aurora`.
2. User asks: "Make this slower and smoother, with soft gold near the center."
3. Lightweaver sends the selected pattern context and instruction to the local server.
4. The server asks the AI provider for a structured draft.
5. The browser validates and compiles the draft.
6. The drawer shows "Aurora Glass Drift" as an unapplied draft.
7. User can ask another refinement, edit the code, retry, compare, or accept.
8. Accepting a built-in transform saves a new custom pattern.

## Pattern Draft Contract

The AI endpoint returns a strict JSON object:

```json
{
  "name": "Aurora Glass Drift",
  "description": "A slower, smoother aurora with subtle gold center glow.",
  "changeSummary": [
    "Reduced motion speed",
    "Softened noise contrast",
    "Added a low-intensity radial gold layer"
  ],
  "palette": ["#102a2b", "#57e7c1", "#9476ff", "#d6b56c"],
  "code": "// @param speed float 0.06 0.01 0.4\nreturn samplePalette(time);",
  "suggestedParams": {
    "speed": 0.06,
    "smoothness": 0.8
  }
}
```

Required fields:

- `name`: display name for the draft.
- `description`: short human-readable description.
- `changeSummary`: 1 to 6 concrete changes.
- `palette`: 2 to 8 valid hex colors.
- `code`: Lightweaver pattern JS function body.

Optional fields:

- `suggestedParams`: parameter values keyed by `@param` names found in the code.
- `notes`: brief implementation notes for advanced users.

## AI Request Contract

The browser sends a request to the local Lightweaver server:

```json
{
  "mode": "transform",
  "instruction": "slower and smoother",
  "sourcePattern": {
    "id": "aurora",
    "name": "Aurora",
    "description": "Slow curtains of northern lights drifting across the sky",
    "code": "// @param speed float 0.15 0.02 0.6\nconst drift = fbm(x * 2 + t * params.speed, y * 1.5, 3);\nconst curtain = fbm(x * 3 - t * params.speed * 0.7, drift * 2, 4);\nconst h = mix(0.35, 0.82, curtain);\nreturn hsv(h, 0.85, pow(curtain, 1.2));",
    "palette": ["#003311", "#00cc66", "#00ffaa", "#6600aa"],
    "params": { "speed": 0.15 },
    "isCustom": false
  },
  "draftPattern": null,
  "projectContext": {
    "ledCount": 612,
    "stripCount": 5,
    "hasAudio": true,
    "hasMappedXY": true
  }
}
```

Modes:

- `create`: generate a new pattern from a blank or starter context.
- `transform`: transform the selected pattern.
- `refine`: transform the current draft using a follow-up instruction.

For `refine`, `draftPattern` contains the current unapplied draft and `sourcePattern` remains the accepted base.

## Server Design

Add a local server route:

```text
POST /api/ai/pattern
```

The route is implemented in the existing Lightweaver server. It is responsible for:

- Reading AI provider credentials from server-side environment variables.
- Building the provider prompt from the request.
- Enforcing structured JSON output.
- Returning the parsed draft JSON to the browser.
- Returning provider and validation errors in a user-readable form.

The implementation can route each request through OpenAI, Anthropic, or OpenRouter. The browser chooses a provider, but it must never receive or store provider API keys.

Environment variables:

- `AI_PATTERN_PROVIDER`: optional server default, one of `openai`, `anthropic`, or `openrouter`.
- `OPENAI_API_KEY`: required when using ChatGPT/OpenAI generation.
- `ANTHROPIC_API_KEY`: required when using Claude/Anthropic generation.
- `OPENROUTER_API_KEY`: required when using OpenRouter generation.
- `AI_PATTERN_MODEL`: optional shared model override.
- `AI_PATTERN_OPENAI_MODEL`, `AI_PATTERN_ANTHROPIC_MODEL`, `AI_PATTERN_OPENROUTER_MODEL`: optional provider-specific model overrides.

If no API key is configured, the assistant drawer should show a setup message and keep the rest of Lightweaver usable.

## Client Design

Add an assistant drawer component near the existing pattern mode UI. The component owns:

- Conversation messages.
- Current draft pattern.
- Pending/loading state.
- Last raw error.
- Draft comparison state.

The drawer should call a small client API helper, for example:

```text
requestAiPatternDraft(payload)
```

Draft validation should use existing pattern infrastructure where possible:

- Compile with `compile()` from `lightweaver/src/lib/patterns.js`.
- Parse `@param` comments using the existing parser behavior in `PatternModes.jsx`.
- Preview with the same render path used by the current pattern preview.
- Save through the existing custom pattern storage path, extended as needed for update-in-place.

## Code Safety and Validation

Generated code is still JavaScript, so it must be treated as untrusted draft content until it passes validation.

Validation steps:

1. Parse the AI response as JSON.
2. Check required fields and field lengths.
3. Validate palette hex colors.
4. Compile `code` with the existing pattern compiler.
5. Parse `@param` declarations.
6. Render a short preview frame set against current strip geometry.
7. Reject drafts that throw runtime errors or render fully black/blank unless the prompt clearly requested blackout.

The prompt should instruct the AI to use only the Lightweaver pattern API:

- Inputs: `index`, `x`, `y`, `t`, `time`, `pixelCount`, `palette`, `beat`, `beatSin`, `params`, `stripId`, `stripProgress`, `bass`, `mid`, `hi`.
- Helpers: existing math, color, wave, noise, palette, and polar helpers from the pattern compiler.
- Output: return `{ r, g, b }`, `[r, g, b]`, or values compatible with the existing evaluator.

The validator should reject obvious browser or network access attempts, including `fetch`, `XMLHttpRequest`, `localStorage`, `document`, `window`, `Function`, `eval`, and import-like syntax.

## Save and Accept Behavior

Accepting a draft follows this rule:

- If the source pattern is built-in, create a new custom pattern.
- If the source pattern is custom, update that custom pattern in place.

For custom updates, store the previous version in a local revision history before overwriting. A minimal history is enough for the first version:

```json
{
  "patternId": "custom_aurora_glass_drift",
  "revisions": [
    {
      "savedAt": 1779460345,
      "name": "Aurora Glass Drift",
      "code": "// @param speed float 0.06 0.01 0.4\nconst drift = fbm(x * 1.8 + t * params.speed, y * 1.2, 4);\nreturn samplePalette(drift);",
      "palette": ["#102a2b", "#57e7c1"]
    }
  ]
}
```

The first implementation should expose a simple Revert action for the most recent previous version.

## Error Handling

The assistant drawer should handle:

- Missing API key.
- Provider timeout.
- Provider rate limit.
- Invalid JSON.
- Missing required fields.
- Compile error.
- Runtime preview error.
- Blank draft.

Errors should not change the current pattern. The drawer should show clear next actions:

- Retry: send the same request again.
- Simplify: ask the AI to produce a shorter, safer version.
- Show raw response: reveal the provider response for debugging.

## Testing

Test coverage should focus on deterministic behavior without real AI calls:

- Server endpoint returns a valid mocked draft.
- Server endpoint reports missing API key cleanly.
- Client validates valid and invalid draft JSON.
- Client rejects uncompilable pattern code.
- Client rejects unsafe code tokens.
- Built-in accept creates a new custom pattern.
- Custom accept updates in place and records history.
- Refinement uses the current draft when one exists.
- Drawer does not alter the accepted pattern before Accept.

Existing Playwright tests can cover the main user flow with mocked `/api/ai/pattern` responses.

## Implementation Boundaries

This feature should be built as an additive layer on the existing pattern system. The implementation should avoid replacing the current code editor, pattern library, renderer, WLED streaming path, or project model unless a narrow extension is needed.

The first version should prioritize:

- Prompt to draft.
- Transform selected pattern.
- Refine current draft.
- Validate and preview.
- Accept into custom pattern storage.

Later versions can add:

- Side-by-side animated comparison.
- Multiple draft variations.
- Prompt presets.
- Local/offline model support on the Raspberry Pi.
- A dedicated AI Studio workspace.

## Implementation Notes

The AI provider calls run on the Lightweaver server, not in the browser. OpenAI uses the JavaScript SDK and structured Responses output. Anthropic and OpenRouter use server-side HTTP calls and are normalized back into the same Lightweaver draft JSON object.

The browser validates every draft with the local Lightweaver compiler and preview renderer before showing an Accept action. Built-in pattern transforms save as new custom patterns. Existing custom pattern transforms update in place and keep local revision history.

If `AI_PATTERN_AUTH_TOKEN` is enabled on the server, the browser assistant sends a matching token from `window.LIGHTWEAVER_AI_TOKEN` or `localStorage.lw_ai_pattern_token`.
