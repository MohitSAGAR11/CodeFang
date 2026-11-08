import {
  Output,
  extractJsonMiddleware,
  generateText,
  stepCountIs,
  wrapLanguageModel,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { getAgentModel } from "../../ai/ai.config.ts";
import { Spinner } from "../../tui/spinner.ts";
import { toolLabel } from "../../tui/agent-stream.ts";
import { ActionTracker } from "../agent/action-tracker.ts";
import { ToolExecutor } from "../agent/tool-executor.ts";
import { defaultAgentConfig } from "../agent/types.ts";
import { createReadOnlyTools } from "../agent/agent-tools.ts";
import type { Plan, PlanStep } from "./types.ts";
import { createWebTools } from "./web-tools.ts";

const planSchema = z.object({
  researchSummary: z.string().optional(),
  steps: z
    .array(
      z.object({
        title: z.string(),
        description: z.string(),
        hints: z.array(z.string()).optional(),
        complexity: z.enum(["low", "medium", "high"]).optional(),
      }),
    )
    .min(1)
    .max(15),
});

const PLAN_INSTRUCTIONS = (codebase: string, hasWeb: boolean) =>
  [
    "You are a Plan-Mode planner. You DO NOT modify files.",
    `Workspace: ${codebase}`,
    "Use read-only tools for codebase/skills research.",
    hasWeb
      ? "Web tools are available. Use them only when needed."
      : "Web tools are unavailable (no FIRECRAWL_API_KEY).",
    "Output must match the provided JSON schema.",
    "Keep it short: 1–15 steps.",
  ].join("\n");

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

export interface DraftPlanOptions {
  goal: string;
  model: WrappableModel;
  tools: ToolSet;
  /** Shown to the model as the workspace (a path, or a repo name). */
  workspaceLabel: string;
  hasWeb: boolean;
  maxSteps?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Called with each tool name the planner uses while researching. */
  onToolCall?: (toolName: string, input: unknown) => void;
}

/**
 * Research with read-only tools, then return a validated 1–15 step plan.
 * Shared by the terminal planner and the web playground.
 */
export async function draftPlan(opts: DraftPlanOptions): Promise<Plan> {
  const model = wrapLanguageModel({
    model: opts.model,
    middleware: extractJsonMiddleware(),
  });

  const result = await generateText({
    model,
    tools: opts.tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 20),
    maxOutputTokens: opts.maxOutputTokens,
    abortSignal: opts.abortSignal,
    system: PLAN_INSTRUCTIONS(opts.workspaceLabel, opts.hasWeb),
    prompt: `User goal: 
${opts.goal}`,
    output: Output.object({ schema: planSchema }),
    onStepFinish: ({ toolCalls }) => {
      for (const call of toolCalls) opts.onToolCall?.(call.toolName, call.input);
    },
  });

  const validated = planSchema.parse(result.output);

  const steps: PlanStep[] = validated.steps.map((s, i) => ({
    id: `step-${i + 1}`,
    title: s.title,
    description: s.description,
    hints: s.hints,
    complexity: s.complexity,
  }));

  return { goal: opts.goal, researchSummary: validated.researchSummary, steps };
}

export async function generatePlan(goal: string): Promise<Plan> {
  const config = defaultAgentConfig();
  const tracker = new ActionTracker();
  const executor = new ToolExecutor(tracker, config);
  const hasWeb = !!process.env.FIRECRAWL_API_KEY;

  const tools = {
    ...createReadOnlyTools(executor),
    ...(hasWeb ? createWebTools(tracker) : {}),
  };

  const spinner = new Spinner();
  spinner.start("Researching & drafting a plan…");
  try {
    return await draftPlan({
      goal,
      model: getAgentModel(),
      tools,
      workspaceLabel: config.codebasePath,
      hasWeb,
      onToolCall: (name) => spinner.update(toolLabel(name)),
    });
  } finally {
    spinner.stop();
  }
}
