import type { ActionLog } from "./types.ts";
import { composeBeforeAfter, formatPatch } from "./diff-view.ts";

export type ReviewKind = "file" | "folder" | "shell";

export interface ReviewGroup {
  kind: ReviewKind;
  label: string;
  actionIds: string[];
  patch: string | null;
}

/** Collapse pending mutations into one reviewable unit per path, plus one per shell command. */
export function groupPending(pending: ActionLog[]): ReviewGroup[] {
  const byPath = new Map<string, ActionLog[]>();
  const shells: ActionLog[] = [];

  for (const a of pending) {
    if (a.type === "tool_execute") {
      shells.push(a);
      continue;
    }
    if (!byPath.has(a.path)) byPath.set(a.path, []);
    byPath.get(a.path)!.push(a);
  }

  const groups: ReviewGroup[] = [];

  const pathEntries = [...byPath.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [p, acts] of pathEntries) {
    const sorted = [...acts].sort(
      (x, y) => x.timestamp.getTime() - y.timestamp.getTime(),
    );
    const ids = sorted.map((x) => x.id);

    if (sorted.every((x) => x.type === "folder_create")) {
      groups.push({
        kind: "folder",
        label: `Create folder: ${p}`,
        actionIds: ids,
        patch: null,
      });
      continue;
    }

    const { before, after } = composeBeforeAfter(sorted);
    const kinds = [...new Set(sorted.map((x) => x.type))].join(", ");
    groups.push({
      kind: "file",
      label: `${p} (${kinds})`,
      actionIds: ids,
      patch: formatPatch(p, before, after),
    });
  }

  for (const s of shells) {
    groups.push({
      kind: "shell",
      label: `Shell: ${s.details.command ?? "(no command)"}`,
      actionIds: [s.id],
      patch: null,
    });
  }

  return groups;
}
