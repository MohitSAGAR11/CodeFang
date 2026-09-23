import { text, isCancel } from "@clack/prompts";
import { stepCountIs, ToolLoopAgent } from "ai";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTools } from "./agent-tools";
import { getAgentModel } from "../../ai";
import { runApprovalFlow } from "./approval";
import { Spinner } from "../../tui/spinner.ts";
import { renderAgentStream } from "../../tui/agent-stream.ts";
import { ask, c, GLYPH, printDone, printError, printSection } from "../../tui/theme.ts";

export async function runAgentMode() {
  printSection("Agent", "stage changes, review, then apply");

  const goal = await text({
    message: ask("What would you like the agent to do?"),
    placeholder: "Concrete task for this codebase…",
  });

  if (isCancel(goal) || !goal.trim()) return;

  const config = defaultAgentConfig();
  const tracker = new ActionTracker();
  const executor = new ToolExecutor(tracker, config);
  const tools = createAgentTools(executor);

  const agent = new ToolLoopAgent({
    model: getAgentModel(),
    stopWhen: stepCountIs(40),
    instructions: [
      `Workspace root: ${config.codebasePath}`,
      "All mutations are staged until approval.",
    ].join("\n"),
    tools,
  });

  const spinner = new Spinner();
  spinner.start("Thinking…");

  try {
    const result = await agent.stream({ prompt: goal.trim() });
    await renderAgentStream(result.fullStream, spinner);
  } catch (err) {
    spinner.stop();
    printError(err);
    return executor.clearStaging();
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
