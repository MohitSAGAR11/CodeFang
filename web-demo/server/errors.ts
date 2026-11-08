import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, RetryError } from "ai";

export interface PublicError {
  code:
    | "bad_key"
    | "insufficient_credits"
    | "model_rate_limited"
    | "model_unavailable"
    | "model_error"
    | "plan_invalid"
    | "timeout"
    | "cancelled"
    | "internal";
  message: string;
}

const MAX_MESSAGE = 280;

/** Strip anything that looks like a secret, then clip. */
export function scrub(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  out = out.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE - 1)}…` : out;
}

function upstreamMessage(err: APICallError): string | undefined {
  const data = err.data as { error?: { message?: unknown }; message?: unknown } | undefined;
  const m = data?.error?.message ?? data?.message;
  return typeof m === "string" ? m : undefined;
}

/**
 * Map anything the agent loop throws to a stable code and a visitor-safe
 * message. Stack traces, headers and keys never leave the server.
 */
export function toPublicError(err: unknown, secrets: Array<string | undefined>, reason?: "timeout" | "cancelled"): PublicError {
  if (reason === "timeout") {
    return { code: "timeout", message: "The run hit the playground's time limit and was stopped." };
  }
  if (reason === "cancelled") return { code: "cancelled", message: "Run cancelled." };

  if (RetryError.isInstance(err)) return toPublicError(err.lastError, secrets);

  if (APICallError.isInstance(err)) {
    const detail = scrub(upstreamMessage(err) ?? "", secrets);
    switch (err.statusCode) {
      case 401:
      case 403:
        return { code: "bad_key", message: "OpenRouter rejected the API key." };
      case 402:
        return { code: "insufficient_credits", message: "That OpenRouter account is out of credits." };
      case 429:
        return {
          code: "model_rate_limited",
          message: "The model is rate-limited upstream right now. Wait a minute, pick another model, or use your own key.",
        };
      case 404:
        if (/guardrail|data policy|privacy/i.test(detail)) {
          return {
            code: "model_unavailable",
            message: "No provider for this model matches the key's privacy settings (OpenRouter data policy). Pick another model, or use your own key.",
          };
        }
        return { code: "model_unavailable", message: detail || "That model isn't available for this key." };
      default:
        return { code: "model_error", message: detail || `The model provider returned ${err.statusCode ?? "an error"}.` };
    }
  }

  if (NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err)) {
    return { code: "plan_invalid", message: "The model didn't return a valid plan. Try again, or pick another model." };
  }

  if (err instanceof Error && err.name === "ZodError") {
    return { code: "plan_invalid", message: "The model's plan didn't match the expected shape. Try again." };
  }

  return { code: "internal", message: "Something went wrong while running the agent." };
}
