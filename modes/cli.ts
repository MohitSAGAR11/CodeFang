import { select, isCancel } from "@clack/prompts";
import { runAgentMode } from "./agent/orchestrator";
import { runAskMode } from "./ask/orchestartor";
import { runPlanMode } from "./plan/orchestrator";
import { ask, c, GLYPH, printError } from "../tui/theme.ts";

export async function runCliMode() {
  while (true) {
    const mode = await select({
      message: ask("Choose a CLI mode"),
      options: [
        { value: "agent", label: "Agent", hint: "make changes, then review" },
        { value: "plan", label: "Plan", hint: "break a goal into steps" },
        { value: "ask", label: "Ask", hint: "questions, read-only" },
        { value: "back", label: `${GLYPH.prompt} Back to main menu` },
      ],
    });

    if (isCancel(mode) || mode === "back") {
      console.log(c.muted(`\n${GLYPH.fang} Back.\n`));
      return;
    }

    try {
      if (mode === "agent") await runAgentMode();
      else if (mode === "plan") await runPlanMode();
      else if (mode === "ask") await runAskMode();
    } catch (err) {
      printError(err);
    }
  }
}
