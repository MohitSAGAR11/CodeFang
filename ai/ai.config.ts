import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export interface ModelOptions {
  /** Falls back to OPENROUTER_API_KEY. */
  apiKey?: string;
  /** Falls back to OPENROUTER_DEFAULT_MODEL. */
  modelId?: string;
}

/** Build an OpenRouter chat model. The web playground passes a per-request key and model. */
export function createModel(opts: ModelOptions = {}) {
  const provider = createOpenRouter({
    apiKey: opts.apiKey ?? process.env.OPENROUTER_API_KEY,
  });

  const modelId = opts.modelId ?? process.env.OPENROUTER_DEFAULT_MODEL;

  if (!modelId) {
    throw new Error("OPENROUTER_DEFAULT_MODEL is not defined");
  }

  return provider(modelId);
}

export function getAgentModel() {
  return createModel();
}
