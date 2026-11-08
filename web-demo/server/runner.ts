import { ToolLoopAgent, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { ActionTracker } from "../../modes/agent/action-tracker.ts";
import { ToolExecutor } from "../../modes/agent/tool-executor.ts";
import { draftPlan } from "../../modes/plan/planner.ts";
import type { PlanStep } from "../../modes/plan/types.ts";
import type { StepCaps } from "./config.ts";
import { buildReviewGroups } from "./review.ts";
import type { Session } from "./sessions.ts";
import { createPlaygroundTools, playgroundAgentConfig, type PlaygroundCaps } from "./web-tools.ts";

export type RunMode = "ask" | "plan" | "plan-exec" | "agent";

export interface RunRequest {
  mode: RunMode;
  prompt: string;
  stepIds?: string[];
}

export type Emit = (event: string, data: unknown) => void;

export interface RunContext {
  model: LanguageModel;
  caps: StepCaps;
  repoCaps: PlaygroundCaps;
  firecrawl: boolean;
  signal: AbortSignal;
  emit: Emit;
}

export interface RunSummary {
  steps: number;
  hitStepCap: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

const MUTATING = new Set(["create_file", "modify_file", "delete_file", "create_folder"]);
const MAX_PREVIEW = 96;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The most human-readable argument of a tool call. */
export function argPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const key = ["path", "query", "url", "pattern", "root"].find((k) => typeof o[k] === "string" && o[k]);
  const value = key ? String(o[key]) : JSON.stringify(o);
  const extra = key === "pattern" && typeof o.root === "string" ? ` in ${o.root}` : "";
  return clip(value + extra, MAX_PREVIEW);
}

function resultSummary(name: string, output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (name === "read_file") return `${text.split("\n").length} lines`;
  if (name === "list_files" || name === "search_files") {
    if (text.startsWith("(")) return text;
    return `${text.split("\n").length} entries`;
  }
  return clip(text.split("\n")[0] ?? "", 120);
}

const errorText = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 160);

const INSTRUCTIONS = {
  base: (label: string) => [
    "You are CodeFang, a coding agent running inside a public web playground.",
    `Workspace: a virtual repository "${label}" held in memory. Paths are relative to its root; use "." for the root.`,
    "There is no shell, no package manager and no network: you cannot run code or tests. Reason from the source.",
  ],
  ask: [
    "You are read-only in this mode.",
    "Explore with list_files/search_files/read_file, then answer concisely in Markdown. Cite file paths in backticks.",
  ],
  agent: [
    "Every create_file / modify_file / delete_file call is staged in an overlay. The visitor reviews a diff before anything is applied.",
    "Always read a file before modifying it. modify_file takes the COMPLETE new file contents, never a fragment.",
    "Keep changes small and focused on the task. Match the existing code style.",
    "When you are done, reply with a short Markdown summary: what changed, in which files, and why.",
  ],
};

interface Pumped extends RunSummary {
  text: string;
}

/** Forward an agent's fullStream to the client as typed events. */
async function pump(
  stream: AsyncIterable<unknown>,
  ctx: RunContext,
  tracker: ActionTracker,
  maxSteps: number,
): Promise<Pumped> {
  let text = "";
  let steps = 0;
  let lastFinish = "";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for await (const raw of stream) {
    const part = raw as {
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
      error?: unknown;
      finishReason?: string;
      preliminary?: boolean;
      totalUsage?: { inputTokens?: number; outputTokens?: number };
    };

    switch (part.type) {
      case "text-delta":
        if (part.text) {
          text += part.text;
          ctx.emit("text", { delta: part.text });
        }
        break;
      case "tool-call":
        ctx.emit("tool", { id: part.toolCallId, name: part.toolName, preview: argPreview(part.input) });
        break;
      case "tool-result":
        if (part.preliminary) break;
        ctx.emit("tool-done", {
          id: part.toolCallId,
          name: part.toolName,
          ok: true,
          summary: resultSummary(part.toolName ?? "", part.output),
        });
        if (MUTATING.has(part.toolName ?? "")) ctx.emit("staged", stagedSnapshot(tracker));
        break;
      case "tool-error":
        ctx.emit("tool-done", { id: part.toolCallId, name: part.toolName, ok: false, summary: errorText(part.error) });
        break;
      case "finish-step":
        steps++;
        lastFinish = part.finishReason ?? "";
        ctx.emit("step", { steps, max: maxSteps });
        break;
      case "finish":
        inputTokens = part.totalUsage?.inputTokens;
        outputTokens = part.totalUsage?.outputTokens;
        break;
      case "error":
        throw part.error;
    }
  }

  return { text, steps, hitStepCap: steps >= maxSteps && lastFinish === "tool-calls", inputTokens, outputTokens };
}

function stagedSnapshot(tracker: ActionTracker) {
  return {
    groups: buildReviewGroups(tracker).map(({ id, path, change, added, removed }) => ({ id, path, change, added, removed })),
  };
}

function newWorkspace(session: Session, ctx: RunContext, write: boolean) {
  const tracker = new ActionTracker();
  const config = playgroundAgentConfig(session.label, write, ctx.repoCaps);
  const executor = new ToolExecutor(tracker, config, session.repo);
  const tools = createPlaygroundTools(executor, tracker, { write, firecrawl: ctx.firecrawl && !write });
  return { tracker, executor, tools };
}

async function runLoop(
  prompt: string,
  instructions: string[],
  tools: ToolSet,
  maxSteps: number,
  ctx: RunContext,
  tracker: ActionTracker,
): Promise<Pumped> {
  const agent = new ToolLoopAgent({
    model: ctx.model,
    instructions: instructions.join("\n"),
    tools,
    stopWhen: stepCountIs(maxSteps),
    maxOutputTokens: ctx.caps.maxOutputTokens,
    // Free upstream models throttle in bursts; the SDK backs off between retries.
    maxRetries: 2,
  });
  // Errors still arrive as `error` stream parts (handled in pump); the no-op
  // replaces the SDK's default console.error so upstream error text never hits logs.
  const streamOptions = { prompt, abortSignal: ctx.signal, onError: () => {} };
  const result = await agent.stream(streamOptions);
  return pump(result.fullStream, ctx, tracker, maxSteps);
}

const addSummary = (a: RunSummary, b: RunSummary): RunSummary => ({
  steps: a.steps + b.steps,
  hitStepCap: a.hitStepCap || b.hitStepCap,
  inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
});

function finishWithReview(session: Session, ctx: RunContext, tracker: ActionTracker, executor: ToolExecutor): void {
  const groups = buildReviewGroups(tracker);
  if (groups.length) session.pending = { tracker, executor, groups };
  else executor.clearStaging();
  ctx.emit("review", { groups });
}

/** Run one request against a session. Throws on model/abort errors; the caller maps them. */
export async function executeRun(session: Session, req: RunRequest, ctx: RunContext): Promise<RunSummary> {
  const base = INSTRUCTIONS.base(session.label);

  if (req.mode === "ask") {
    const { tracker, tools } = newWorkspace(session, ctx, false);
    return runLoop(req.prompt, [...base, ...INSTRUCTIONS.ask], tools, ctx.caps.ask, ctx, tracker);
  }

  if (req.mode === "agent") {
    const { tracker, executor, tools } = newWorkspace(session, ctx, true);
    const summary = await runLoop(req.prompt, [...base, ...INSTRUCTIONS.agent], tools, ctx.caps.agent, ctx, tracker);
    finishWithReview(session, ctx, tracker, executor);
    return summary;
  }

  if (req.mode === "plan") {
    const { tools } = newWorkspace(session, ctx, false);
    let calls = 0;
    const plan = await draftPlan({
      goal: req.prompt,
      model: ctx.model as Parameters<typeof draftPlan>[0]["model"],
      tools,
      workspaceLabel: `virtual repo "${session.label}" (no shell, no network)`,
      hasWeb: ctx.firecrawl,
      maxSteps: ctx.caps.plan,
      maxOutputTokens: ctx.caps.maxOutputTokens,
      abortSignal: ctx.signal,
      onToolCall: (name, input) => {
        const id = `plan-${++calls}`;
        ctx.emit("tool", { id, name, preview: argPreview(input) });
        ctx.emit("tool-done", { id, name, ok: true, summary: "" });
      },
    });
    session.plan = plan;
    ctx.emit("plan", { plan });
    return { steps: calls, hitStepCap: false };
  }

  // plan-exec: run only the steps the visitor ticked, then one review covers all.
  const plan = session.plan;
  if (!plan) throw new PlanMissingError();
  const wanted = new Set(req.stepIds ?? []);
  const steps: PlanStep[] = plan.steps.filter((s) => wanted.has(s.id)).slice(0, ctx.caps.planExecMaxSelected);
  if (!steps.length) throw new PlanMissingError("Pick at least one step to execute.");

  const { tracker, executor, tools } = newWorkspace(session, ctx, true);
  let total: RunSummary = { steps: 0, hitStepCap: false };
  for (const [i, step] of steps.entries()) {
    ctx.emit("phase", { index: i, total: steps.length, id: step.id, title: step.title });
    const prompt = [`Goal: ${plan.goal}`, `Step: ${step.title}`, step.description].join("\n");
    const s = await runLoop(prompt, [...base, ...INSTRUCTIONS.agent], tools, ctx.caps.planExecPerStep, ctx, tracker);
    total = addSummary(total, s);
  }
  finishWithReview(session, ctx, tracker, executor);
  return total;
}

export class PlanMissingError extends Error {
  constructor(message = "Draft a plan first, then pick steps to execute.") {
    super(message);
    this.name = "PlanMissingError";
  }
}
