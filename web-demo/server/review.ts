import { createTwoFilesPatch } from "diff";
import type { ActionTracker } from "../../modes/agent/action-tracker.ts";
import type { ToolExecutor } from "../../modes/agent/tool-executor.ts";
import type { ActionLog } from "../../modes/agent/types.ts";
import { groupPending } from "../../modes/agent/review-groups.ts";
import { composeBeforeAfter } from "../../modes/agent/diff-view.ts";

export type ChangeKind = "created" | "modified" | "deleted" | "folder";

export interface ReviewGroupDTO {
  id: string;
  path: string;
  change: ChangeKind;
  /** Unified diff (same text the terminal shows). Null for folders. */
  patch: string | null;
  added: number;
  removed: number;
  actionIds: string[];
}

export type Decision = "approve" | "reject";

export interface ReviewResult {
  applied: string[];
  rejected: string[];
  errors: string[];
  /** git-apply compatible patch of everything approved ("" when nothing). */
  patch: string;
}

export function countLines(patch: string | null): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!patch) return { added, removed };
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function changeOf(actions: ActionLog[]): ChangeKind | "noop" {
  if (actions.every((a) => a.type === "folder_create")) return "folder";
  const first = actions[0];
  const last = actions[actions.length - 1];
  if (last?.type === "file_delete") return first?.type === "file_create" ? "noop" : "deleted";
  if (first?.type === "file_create") return "created";
  return "modified";
}

const sortByTime = (xs: ActionLog[]) =>
  [...xs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

/** Pending mutations → one reviewable group per path (shell never appears: it is not exposed). */
export function buildReviewGroups(tracker: ActionTracker): ReviewGroupDTO[] {
  const pending = tracker.getPendingMutations();
  const byId = new Map(pending.map((a) => [a.id, a]));

  return groupPending(pending)
    .filter((g) => g.kind !== "shell")
    .flatMap((g) => {
      const actions = sortByTime(g.actionIds.map((id) => byId.get(id)).filter((a): a is ActionLog => !!a));
      const change = changeOf(actions);
      // A file created and then deleted in the same run is a no-op; hide it.
      if (change === "noop") return [];
      return [{ path: actions[0]?.path ?? "", change, patch: g.patch, actionIds: g.actionIds }];
    })
    .map((g, i) => ({ id: `g${i}`, ...g, ...countLines(g.patch) }));
}

/** One file's change in `git diff` format, so the download works with `git apply`. */
export function gitPatchFor(path: string, before: string, after: string, change: ChangeKind): string {
  const oldName = change === "created" ? "/dev/null" : `a/${path}`;
  const newName = change === "deleted" ? "/dev/null" : `b/${path}`;
  const body = createTwoFilesPatch(oldName, newName, before, after, undefined, undefined, { context: 3 })
    .split("\n")
    .filter((l) => !l.startsWith("Index:") && !/^=+$/.test(l))
    .map((l) => (l.startsWith("--- ") || l.startsWith("+++ ") ? l.replace(/\t.*$/, "") : l))
    .join("\n");
  const header = [`diff --git a/${path} b/${path}`];
  if (change === "created") header.push("new file mode 100644");
  if (change === "deleted") header.push("deleted file mode 100644");
  return `${header.join("\n")}\n${body.trimEnd()}\n`;
}

/**
 * Apply the visitor's decisions: approved groups are written to the session's
 * virtual repo through the same `applyApprovedFromTracker` the terminal uses;
 * everything else is rejected and the overlay is discarded.
 */
export function applyDecisions(
  tracker: ActionTracker,
  executor: ToolExecutor,
  groups: ReviewGroupDTO[],
  decisions: Record<string, Decision>,
): ReviewResult {
  const byId = new Map(tracker.getActions().map((a) => [a.id, a]));
  const applied: string[] = [];
  const rejected: string[] = [];
  const patches: string[] = [];

  for (const g of groups) {
    const approve = decisions[g.id] === "approve";
    for (const id of g.actionIds) tracker.updateStatus(id, approve ? "approved" : "rejected", approve);
    if (!approve) {
      rejected.push(g.path);
      continue;
    }
    applied.push(g.path);
    if (g.change !== "folder") {
      const actions = sortByTime(g.actionIds.map((id) => byId.get(id)).filter((a): a is ActionLog => !!a));
      const { before, after } = composeBeforeAfter(actions);
      patches.push(gitPatchFor(g.path, before, after, g.change));
    }
  }

  // Anything pending that was not in a group (e.g. no-op create+delete) is rejected too.
  for (const a of tracker.getPendingMutations()) tracker.updateStatus(a.id, "rejected", false);

  const { errors } = executor.applyApprovedFromTracker();
  executor.clearStaging();
  return { applied, rejected, errors, patch: patches.join("") };
}
