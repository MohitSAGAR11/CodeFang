import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export function getAgentModel() {
  const provier = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

  const modelId = process.env.OPENROUTER_DEFAULT_MODEL;

  if (!modelId) {
    throw new Error("OPENROUTER_MODEL is not defined");
  }
  
  return provier(modelId);
}
