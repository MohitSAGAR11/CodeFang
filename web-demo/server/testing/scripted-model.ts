import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

/** One model turn: optional tool calls, then optional text. */
export interface Turn {
  tools?: Array<{ name: string; input: Record<string, unknown> }>;
  text?: string;
}

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/**
 * A deterministic stand-in for OpenRouter, used by tests and by the local
 * mock dev server (UI work and screenshots without spending real requests).
 * Each call to the model consumes the next turn; after the script runs out
 * it answers with a short closing line.
 */
export function scriptedModel(turns: Turn[], opts: { chunkDelayMs?: number } = {}) {
  let i = 0;
  const next = (): Turn => turns[i++] ?? { text: "Done." };

  const toContent = (turn: Turn) => [
    ...(turn.tools ?? []).map((t, n) => ({
      type: "tool-call" as const,
      toolCallId: `call-${i}-${n}`,
      toolName: t.name,
      input: JSON.stringify(t.input),
    })),
    ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
  ];

  const finishReason = (turn: Turn) => ({
    unified: (turn.tools?.length ? "tool-calls" : "stop") as "tool-calls" | "stop",
    raw: undefined,
  });

  return new MockLanguageModelV4({
    modelId: "scripted",
    doGenerate: async () => {
      const turn = next();
      return { content: toContent(turn), finishReason: finishReason(turn), usage, warnings: [] };
    },
    doStream: async () => {
      const turn = next();
      const words = turn.text ? turn.text.match(/\S+\s*/g) ?? [] : [];
      const chunks = [
        { type: "stream-start" as const, warnings: [] },
        ...(turn.tools ?? []).map((t, n) => ({
          type: "tool-call" as const,
          toolCallId: `call-${i}-${n}`,
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
        { type: "finish" as const, finishReason: finishReason(turn), usage },
      ];
      return {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: opts.chunkDelayMs ? opts.chunkDelayMs * 4 : 0,
          chunkDelayInMs: opts.chunkDelayMs ?? 0,
        }),
      };
    },
  });
}
