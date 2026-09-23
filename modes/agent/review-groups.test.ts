import { describe, expect, test } from "bun:test";
import { groupPending } from "./review-groups.ts";
import type { ActionLog, ActionType } from "./types.ts";

let seq = 0;

function action(
  type: ActionType,
  filePath: string,
  details: ActionLog["details"] = {},
): ActionLog {
  seq += 1;
  return {
    id: `action_${seq}`,
    // Ordering inside a group is by timestamp, so keep them distinct.
    timestamp: new Date(2026, 0, 1, 0, 0, seq),
    type,
    path: filePath,
    details,
    status: "pending",
  };
}

describe("groupPending", () => {
  test("collapses every action on one path into a single group", () => {
    const groups = groupPending([
      action("file_create", "a.ts", { after: "one" }),
      action("file_modify", "a.ts", { before: "one", after: "two" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("file");
    expect(groups[0]!.actionIds).toHaveLength(2);
    expect(groups[0]!.label).toContain("a.ts");
    expect(groups[0]!.label).toContain("file_create");
    expect(groups[0]!.label).toContain("file_modify");
  });

  test("builds a patch spanning the first before to the last after", () => {
    const groups = groupPending([
      action("file_modify", "a.ts", { before: "start", after: "middle" }),
      action("file_modify", "a.ts", { before: "middle", after: "end" }),
    ]);

    const patch = groups[0]!.patch!;
    expect(patch).toContain("-start");
    expect(patch).toContain("+end");
    // The intermediate state is not part of the reviewed diff.
    expect(patch).not.toContain("+middle");
  });

  test("treats a create as a diff against nothing", () => {
    const groups = groupPending([
      action("file_create", "fresh.ts", { after: "brand new" }),
    ]);
    expect(groups[0]!.patch).toContain("+brand new");
  });

  test("treats a delete as a diff to nothing", () => {
    const groups = groupPending([
      action("file_delete", "old.ts", { before: "goodbye" }),
    ]);
    expect(groups[0]!.patch).toContain("-goodbye");
  });

  test("labels a folder group and gives it no patch", () => {
    const groups = groupPending([action("folder_create", "src/new")]);
    expect(groups[0]!.kind).toBe("folder");
    expect(groups[0]!.patch).toBeNull();
    expect(groups[0]!.label).toBe("Create folder: src/new");
  });

  test("gives each shell command its own group", () => {
    const groups = groupPending([
      action("tool_execute", "shell", { command: "bun test" }),
      action("tool_execute", "shell", { command: "bun run build" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "shell")).toBe(true);
    expect(groups[0]!.label).toBe("Shell: bun test");
    expect(groups[1]!.label).toBe("Shell: bun run build");
  });

  test("separates files, folders and shells in one review", () => {
    const groups = groupPending([
      action("file_create", "b.ts", { after: "x" }),
      action("folder_create", "sub"),
      action("tool_execute", "shell", { command: "ls" }),
      action("file_modify", "a.ts", { before: "1", after: "2" }),
    ]);

    expect(groups.map((g) => g.kind)).toEqual([
      "file",
      "file",
      "folder",
      "shell",
    ]);
    // Paths sort alphabetically; shells always come last.
    expect(groups[0]!.label).toContain("a.ts");
    expect(groups[1]!.label).toContain("b.ts");
  });

  test("every pending action lands in exactly one group", () => {
    const pending = [
      action("file_create", "a.ts", { after: "x" }),
      action("file_modify", "a.ts", { before: "x", after: "y" }),
      action("folder_create", "sub"),
      action("tool_execute", "shell", { command: "ls" }),
    ];

    const ids = groupPending(pending).flatMap((g) => g.actionIds);
    expect(ids.sort()).toEqual(pending.map((a) => a.id).sort());
  });

  test("handles an empty review", () => {
    expect(groupPending([])).toEqual([]);
  });

  test("survives a shell action with no command recorded", () => {
    const groups = groupPending([action("tool_execute", "shell")]);
    expect(groups[0]!.label).toBe("Shell: (no command)");
  });
});
