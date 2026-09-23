import { confirm, isCancel, text } from "@clack/prompts";
import { ToolLoopAgent, stepCountIs } from "ai";
import { getAgentModel } from "../../ai/ai.config.ts";
import { ActionTracker } from "../agent/action-tracker.ts";
import { ToolExecutor } from "../agent/tool-executor.ts";
import { createAgentTools } from "../agent/agent-tools.ts";
import { defaultAgentConfig } from "../agent/types.ts";
import { runApprovalFlow } from "../agent/approval.ts";
import { generatePlan } from "./planner.ts";
import { printPlan, selectSteps } from "./selection.ts";
import type { Plan, PlanStep } from "./types.ts";
import { createWebTools } from "./web-tools.ts";
import { Spinner } from "../../tui/spinner.ts";
import { renderAgentStream } from "../../tui/agent-stream.ts";
import {
  ask,
  c,
  GLYPH,
  printDone,
  printError,
  printSection,
} from "../../tui/theme.ts";

function stepPrompt(goal: string, step: PlanStep): string {
  return [`Goal: ${goal}`, `Step: ${step.title}`, step.description].join("\n");
}

export async function runPlanMode(): Promise<void> {
  printSection("Plan", "research a goal, pick steps, then execute");

  const goal = await text({
    message: ask("What is your goal?"),
    placeholder: "Add a retry policy to the web tools…",
  });
  if (isCancel(goal) || !goal.trim()) return;

  let plan: Plan;
  try {
    plan = await generatePlan(goal);
  } catch (err) {
    printError(err);
    return;
  }

  printPlan(plan);

  const selected = await selectSteps(plan);
  if (selected.length === 0) return;

  const proceed = await confirm({
    message: ask(`Execute ${selected.length} step(s)?`),
    initialValue: true,
  });

  if (isCancel(proceed) || !proceed) return;

  const config = defaultAgentConfig();
  const tracker = new ActionTracker();
  const executor = new ToolExecutor(tracker, config);

  const tools = {
    ...createAgentTools(executor),
    ...(process.env.FIRECRAWL_API_KEY ? createWebTools(tracker) : {}),
  };

  for (const [i, step] of selected.entries()) {
    console.log(
      `\n${c.accent(GLYPH.tool)} ${c.brand(step.title)} ${c.muted(`(${i + 1}/${selected.length})`)}`,
    );

    const agent = new ToolLoopAgent({
      model: getAgentModel(),
      stopWhen: stepCountIs(30),
      tools,
    });

    const spinner = new Spinner();
    spinner.start("Working on this step…");

    try {
      const r = await agent.stream({ prompt: stepPrompt(plan.goal, step) });
      await renderAgentStream(r.fullStream, spinner);
    } catch (err) {
      spinner.stop();
      printError(err);
      break;
    }
  }

  const ok = await runApprovalFlow(tracker);
  if (!ok) return executor.clearStaging();

  const { errors } = executor.applyApprovedFromTracker();
  if (errors.length) {
    console.log(c.warn(`\n${GLYPH.err} Some operations reported errors:\n`));
    for (const e of errors) console.log(c.error(`  ${GLYPH.dot} ${e}`));
    console.log();
  } else {
    printDone("Applied.");
  }
  executor.clearStaging();
}
