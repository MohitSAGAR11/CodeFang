import { select, isCancel } from "@clack/prompts";
import type { ActionTracker } from "./action-tracker.ts";
import { groupPending } from "./review-groups.ts";
import { renderTerminalMarkdown } from "../../tui/terminal-md.ts";
import { ask, c, GLYPH } from "../../tui/theme.ts";

export async function runApprovalFlow(
  tracker: ActionTracker,
): Promise<boolean> {
  const pending = tracker.getPendingMutations();

  if (pending.length === 0) {
    console.log(
      c.muted(`\n${GLYPH.dot} No staged file, folder, or shell changes.\n`),
    );
    return false;
  }

  const choice = await select({
    message: ask(`Apply ${pending.length} staged change(s)?`),
    options: [
      { value: "all", label: "Approve and apply all" },
      { value: "select", label: "Review one by one", hint: "inspect each diff" },
      { value: "cancel", label: "Cancel", hint: "discard staging" },
    ],
  });

  if (isCancel(choice) || choice === "cancel") {
    for (const a of pending) tracker.updateStatus(a.id, "rejected", false);
    return false;
  }

  if (choice === "all") {
    for (const a of pending) tracker.updateStatus(a.id, "approved", true);
    return true;
  }

  for (const g of groupPending(pending)) {
    while (true) {
      const opt = await select({
        message: `${c.accent(GLYPH.tool)} ${c.brand(g.label)}`,
        options: [
          { value: "accept", label: "Accept" },
          { value: "diff", label: "Show diff", hint: g.patch ? "" : "N/A" },
          { value: "reject", label: "Reject" },
        ],
      });

      if (isCancel(opt)) {
        for (const a of pending) tracker.updateStatus(a.id, "rejected", false);
        return false;
      }

      if (opt === "diff") {
        if (g.patch) {
          console.log(
            "\n" +
              renderTerminalMarkdown("```diff\n" + g.patch + "\n```\n") +
              "\n",
          );
        }

        continue;
      }

      for (const id of g.actionIds) {
        tracker.updateStatus(
          id,
          opt === "accept" ? "approved" : "rejected",
          opt === "accept",
        );
      }
      break;
    }
  }

  return tracker.getActions().some((a) => a.status === "approved");
}
