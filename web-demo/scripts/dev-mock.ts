/**
 * Local-only dev server with a scripted model instead of OpenRouter, so UI
 * work and screenshots don't spend real requests. The agent loop, tools,
 * overlay, review and streaming are all real; only the model's choices are
 * canned. Never used in production (the Dockerfile runs server/main.ts).
 */
import { APICallError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { startServer } from "../server/main.ts";

const FIXED_BACKOFF = `export interface BackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

/**
 * Delay before retry number \`attempt\` (0 = the wait after the first failure).
 *
 * Exponential: base * 2^attempt, jittered, and never above maxDelayMs.
 */
export function computeDelay(
  attempt: number,
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponential = opts.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, opts.maxDelayMs);

  if (!opts.jitter) return capped;

  // "Full jitter": pick a wait between 0 and the capped delay, so retries
  // spread out without ever exceeding maxDelayMs.
  return Math.round(random() * capped);
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
`;

const CAP_TEST = `import { expect, test } from "bun:test";
import { computeDelay } from "../src/backoff";

test("jittered delays never exceed maxDelayMs", () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1_000, jitter: true };
  for (let attempt = 0; attempt < 12; attempt++) {
    expect(computeDelay(attempt, opts, () => 0.999)).toBeLessThanOrEqual(1_000);
  }
});
`;


type Turn = { tools?: Array<{ name: string; input: Record<string, unknown> }>; text?: string };

const SCRIPTS: Record<"agent" | "ask" | "exec" | "noop", Turn[]> = {
  agent: [
    { tools: [{ name: "list_files", input: { path: ".", recursive: true } }] },
    { tools: [{ name: "read_file", input: { path: "src/backoff.ts" } }, { name: "read_file", input: { path: "test/backoff.test.ts" } }] },
    { tools: [{ name: "modify_file", input: { path: "src/backoff.ts", content: FIXED_BACKOFF } }] },
    { tools: [{ name: "create_file", input: { path: "test/cap.test.ts", content: CAP_TEST } }] },
    {
      text:
        "Fixed the cap bug in `src/backoff.ts`.\n\n- **Cause:** jitter was added *on top of* the capped delay (`capped + random() * capped * 0.5`), so a wait could reach 1.5× `maxDelayMs`.\n- **Fix:** switched to full jitter, `random() * capped`, which stays within `[0, maxDelayMs]`.\n- **Test:** added `test/cap.test.ts` asserting no attempt exceeds the cap even with a worst-case random value.",
    },
  ],
  ask: [
    { tools: [{ name: "search_files", input: { root: ".", pattern: "**/*.ts", content_contains: "computeDelay" } }] },
    { tools: [{ name: "read_file", input: { path: "src/backoff.ts" } }] },
    {
      text:
        "`computeDelay` in `src/backoff.ts` does three things:\n\n1. **Exponential growth:** `baseDelayMs * 2 ** attempt` (100 → 200 → 400 ms…).\n2. **Cap:** `Math.min(exponential, maxDelayMs)`.\n3. **Jitter:** when enabled, adds up to 50% *on top* of the capped value.\n\nThat third step runs after the cap, which is why waits can exceed `maxDelayMs`, matching the known issue in the README.",
    },
  ],
  noop: [
    { tools: [{ name: "read_file", input: { path: "README.md" } }] },
    { text: "I looked through the repo and there's nothing to change for that request." },
  ],
  exec: [
    { tools: [{ name: "read_file", input: { path: "src/retry.ts" } }] },
    {
      tools: [
        {
          name: "modify_file",
          input: {
            path: "src/retry.ts",
            content: "// shouldRetry support added by the plan step\n",
          },
        },
      ],
    },
    { text: "Added the option to `src/retry.ts`." },
  ],
};

const PLAN = {
  researchSummary:
    "`retry()` in `src/retry.ts` retries every error and can't be cancelled. Options live in `RetryOptions`; delays come from `computeDelay`.",
  steps: [
    { title: "Add a shouldRetry predicate", description: "Extend RetryOptions with shouldRetry(err, attempt) and stop early when it returns false.", complexity: "low" },
    { title: "Accept an AbortSignal", description: "Add signal to RetryOptions; abort the pending sleep and throw an AbortError.", complexity: "medium" },
    { title: "Document both options", description: "Add the two options to the README table with an example.", complexity: "low" },
  ],
};

const usage = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 120, text: 120, reasoning: 0 },
};

function pickScript(opts: { tools?: Array<{ name: string }>; prompt: Array<{ role: string; content: unknown }> }) {
  const names = (opts.tools ?? []).map((t) => t.name);
  const promptText = JSON.stringify(opts.prompt);
  if (!names.includes("modify_file")) return SCRIPTS.ask;
  if (promptText.includes("no changes")) return SCRIPTS.noop;
  return promptText.includes("Step: ") ? SCRIPTS.exec : SCRIPTS.agent;
}

function demoModel() {
  let turns: Turn[] | null = null;
  let i = 0;
  return new MockLanguageModelV4({
    modelId: "mock",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(PLAN) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async (opts) => {
      // "simulate upstream error" in a prompt exercises the model-error UI.
      if (JSON.stringify(opts.prompt).includes("simulate upstream error")) {
        throw new APICallError({
          message: "rate limited",
          url: "https://openrouter.ai/api/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: false,
        });
      }
      turns ??= pickScript(opts as never);
      const turn = turns[i++] ?? { text: "Done." };
      const words = turn.text?.match(/\S+\s*/g) ?? [];
      return {
        stream: simulateReadableStream({
          initialDelayInMs: 700,
          chunkDelayInMs: 35,
          chunks: [
            { type: "stream-start", warnings: [] },
            ...(turn.tools ?? []).map((t, n) => ({
              type: "tool-call" as const,
              toolCallId: `c${i}-${n}`,
              toolName: t.name,
              input: JSON.stringify(t.input),
            })),
            ...(words.length
              ? [
                  { type: "text-start" as const, id: "t" },
                  ...words.map((w) => ({ type: "text-delta" as const, id: "t", delta: w })),
                  { type: "text-end" as const, id: "t" },
                ]
              : []),
            {
              type: "finish",
              finishReason: { unified: turn.tools?.length ? "tool-calls" : "stop", raw: undefined },
              usage,
            },
          ],
        }),
      };
    },
  });
}

process.env.OPENROUTER_API_KEY ??= "sk-or-v1-mock-key-for-local-dev-only";
await startServer({ modelFactory: () => demoModel(), port: Number(process.env.PORT ?? 5175) });
