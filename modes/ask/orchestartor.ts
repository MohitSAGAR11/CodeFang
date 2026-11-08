import { confirm, isCancel, text } from "@clack/prompts";
import { ToolLoopAgent, stepCountIs } from "ai";
import { getAgentModel } from "../../ai/ai.config.ts";
import { ActionTracker } from "../agent/action-tracker.ts";
import { ToolExecutor } from "../agent/tool-executor.ts";
import { createReadOnlyTools } from "../agent/agent-tools.ts";
import { defaultAgentConfig } from "../agent/types.ts";
import { runApprovalFlow } from "../agent/approval.ts";
import { createWebTools } from "../plan/web-tools.ts";
import { Spinner } from "../../tui/spinner.ts";
import { renderAgentStream } from "../../tui/agent-stream.ts";
import { ask, printError, printSection } from "../../tui/theme.ts";

function asMd(question: string, answer: string): string {
  return `# Ask Mode\n\n## Question\n\n${question.trim()}\n\n## Answer\n\n${answer.trim()}\n`;
}

export async function runAskMode() {
  printSection("Ask", "read-only questions about this codebase");

  const question = await text({
    message: ask("What do you want to ask?"),
    placeholder: "How does the approval flow work?",
  });
  if (isCancel(question) || !question.trim()) return;

  const config = defaultAgentConfig();
  config.tools.allowFileCreation = true;
  config.tools.allowFileModification = false;
  config.tools.allowFolderCreation = false;
  config.tools.allowShellExecution = false;

  const tracker = new ActionTracker();
  const executor = new ToolExecutor(tracker, config);

  const tools = {
    ...createReadOnlyTools(executor),
    ...createWebTools(tracker),
  };

  const agent = new ToolLoopAgent({
    model: getAgentModel(),
    stopWhen: stepCountIs(20),
    tools,
  });

  const spinner = new Spinner();
  spinner.start("Thinking…");

  let answer = "";
  try {
    const result = await agent.stream({ prompt: question.trim() });
    answer = (await renderAgentStream(result.fullStream, spinner)).trim();
  } catch (err) {
    spinner.stop();
    printError(err);
    return executor.clearStaging();
  }

  if (!answer) return;

  const wantsSave = await confirm({
    message: ask("Save this answer to a .md file in the current directory?"),
    initialValue: false,
  });
  if (isCancel(wantsSave) || !wantsSave) return;

  const filename = await text({
    message: ask("Filename"),
    initialValue: "ask.md",
    validate: (v) => {
      const s = (v ?? "").trim();
      if (!s) return "Required";
      if (s.includes("..") || s.includes("/") || s.includes("\\"))
        return "No paths";
      if (!s.toLowerCase().endsWith(".md")) return "Must end with .md";
    },
  });

  if (isCancel(filename)) return;

  executor.createFile(filename, asMd(question, answer));
  const ok = await runApprovalFlow(tracker);
  if (!ok) return executor.clearStaging();

  executor.applyApprovedFromTracker();
  executor.clearStaging();
}
