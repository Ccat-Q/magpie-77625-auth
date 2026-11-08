export const DEFAULT_LIMITS = Object.freeze({ context: 131_072, output: 32_768 });

/**
 * Vendor-documented limits, checked 2026-11-08. The site itself reports
 * context_limit = 0 for every model, so these are the best available values.
 *
 * outputs are what the vendor allows, not what every group on the site allows;
 * the site may cap lower per account.
 */
export const MODEL_LIMITS = Object.freeze({
  "deepseek-flash": { context: 1_000_000, output: 393_216 },
  "deepseek-v4-flash": { context: 1_048_576, output: 384_000 },
  "gemini-3.1-pro": { context: 1_048_576, output: 65_536 },
  "gemini-3.6-flash": { context: 1_048_576, output: 65_536 },
  "gemini-3.8-flash": { context: 1_048_576, output: 65_536 },
  "gemini-4": { context: 1_048_576, output: 1_000_000 },
  "glm-5.2": { context: 1_000_000, output: 65_536 },
  "kimi-k3": { context: 1_000_000, output: 131_072 },
  "opus5.5": { context: 1_000_000, output: 131_072 },
  "sensenova-6.8-flash-lite": { context: 262_144, output: 65_536, free: true },
  "x-deepseek-v4.1-flash": { context: 1_000_000, output: 393_216 },
  "不可信-grok-4.7": { context: 524_288, output: 262_144 },
});

export function limitsFor(modelId) {
  return MODEL_LIMITS[modelId] ?? DEFAULT_LIMITS;
}

export function isFree(model) {
  const prompt = Number(model?.price_prompt);
  const completion = Number(model?.price_completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

export function normalizeModel(modelId, source, extra = {}) {
  const limits = limitsFor(modelId);
  const model = {
    id: modelId,
    name: source?.name || modelId,
    limit: { context: limits.context, output: limits.output },
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  };
  if (limits.free || isFree(source)) model.free = true;
  return { ...model, ...extra };
}

export function staticModels() {
  const models = {};
  for (const modelId of Object.keys(MODEL_LIMITS)) {
    models[modelId] = normalizeModel(modelId);
  }
  return models;
}

/**
 * /api/account/models entries: { name, price_prompt, price_completion, allowed, ... }
 */
export function modelsFromAccount(entries) {
  const models = {};
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    if (entry.allowed === false) continue;
    models[entry.name] = normalizeModel(entry.name, entry);
  }
  return models;
}

/**
 * /v1/models entries: { id, ... } — no prices, so only the static table can
 * mark a model free.
 */
export function modelsFromOpenAI(entries) {
  const models = {};
  for (const entry of entries ?? []) {
    const modelId = typeof entry === "string" ? entry : entry?.id;
    if (typeof modelId !== "string" || !modelId) continue;
    models[modelId] = normalizeModel(modelId);
  }
  return models;
}