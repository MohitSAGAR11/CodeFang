import { Markup } from "telegraf";
import type { ActionTracker } from "../agent/action-tracker.ts";
import type { ToolExecutor } from "../agent/tool-executor.ts";
import type { ActionLog } from "../agent/types.ts";
import { groupPending, type ReviewGroup } from "../agent/review-groups.ts";
import { clip } from "./text.ts";

export interface ApprovalSession {
  tracker: ActionTracker;
  executor: ToolExecutor;
  pending: ActionLog[];
  groups: ReviewGroup[];
  /** Index of the group currently under one-by-one review. */
  cursor: number;
}

export const approvalSessions = new Map<number, ApprovalSession>();

const ICON: Record<ReviewGroup["kind"], string> = {
  file: "📄",
  folder: "📁",
  shell: "🖥",
};

export function approvalSummary(session: ApprovalSession): string {
  return [
    "Staged changes — review before applying",
    "",
    ...session.groups.map((g) => `${ICON[g.kind]} ${g.label}`),
    "",
    `Total: ${session.pending.length} change(s) in ${session.groups.length} group(s)`,
  ].join("\n");
}

export function approvalDiff(session: ApprovalSession): string {
  const parts = session.groups.map((g) =>
    g.patch ? clip(g.patch, 1500) : `${ICON[g.kind]} ${g.label}`,
  );
  return parts.join("\n\n").trim();
}

export function approvalKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📋 Show Diff", "approval_diff")],
    [Markup.button.callback("🔍 Review one by one", "approval_review")],
    [
      Markup.button.callback("✅ Accept All", "approval_accept"),
      Markup.button.callback("❌ Reject All", "approval_reject"),
    ],
  ]);
}

export function currentGroup(session: ApprovalSession): ReviewGroup | undefined {
  return session.groups[session.cursor];
}

export function groupMessage(session: ApprovalSession): string {
  const g = currentGroup(session);
  if (!g) return "Nothing left to review.";
  return [
    `Change ${session.cursor + 1} of ${session.groups.length}`,
    "",
    `${ICON[g.kind]} ${g.label}`,
  ].join("\n");
}

export function groupKeyboard(session: ApprovalSession) {
  const g = currentGroup(session);
  const rows = [];
  if (g?.patch) {
    rows.push([Markup.button.callback("📋 Show Diff", "approval_step_diff")]);
  }
  rows.push([
    Markup.button.callback("✅ Accept", "approval_step_accept"),
    Markup.button.callback("❌ Reject", "approval_step_reject"),
  ]);
  return Markup.inlineKeyboard(rows);
}

/** Mark the current group and advance. Returns true when every group is decided. */
export function decideCurrent(
  session: ApprovalSession,
  accept: boolean,
): boolean {
  const g = currentGroup(session);
  if (g) {
    for (const id of g.actionIds) {
      session.tracker.updateStatus(
        id,
        accept ? "approved" : "rejected",
        accept,
      );
    }
    session.cursor += 1;
  }
  return session.cursor >= session.groups.length;
}

export function setAll(session: ApprovalSession, accept: boolean): void {
  for (const a of session.pending) {
    session.tracker.updateStatus(a.id, accept ? "approved" : "rejected", accept);
  }
}

/** Write approved actions to disk and clear staging. */
export function applyApproval(session: ApprovalSession): {
  applied: number;
  errors: string[];
} {
  const applied = session.tracker
    .getActions()
    .filter((a) => a.status === "approved").length;
  const { errors } = session.executor.applyApprovedFromTracker();
  session.executor.clearStaging();
  return { applied, errors };
}

export function resultMessage(applied: number, errors: string[]): string {
  if (applied === 0) return "❌ Nothing approved. No changes were applied.";
  const head = `✅ Applied ${applied} change(s).`;
  if (!errors.length) return head;
  return [head, "", "⚠️ Some operations reported errors:", ...errors].join("\n");
}

async function promptApproval(
  ctx: { reply: (t: string, o?: object) => Promise<unknown> },
  chatId: number,
  session: ApprovalSession,
) {
  approvalSessions.set(chatId, session);
  await ctx.reply(approvalSummary(session), { ...approvalKeyboard() });
}

export async function finishOrApprove(
  ctx: { reply: (t: string, o?: object) => Promise<unknown> },
  chatId: number,
  tracker: ActionTracker,
  executor: ToolExecutor,
  noChangesMsg: string,
) {
  const pending = tracker.getPendingMutations();
  if (pending.length === 0) {
    await ctx.reply(noChangesMsg);
    return;
  }
  await promptApproval(ctx, chatId, {
    tracker,
    executor,
    pending,
    groups: groupPending(pending),
    cursor: 0,
  });
}
