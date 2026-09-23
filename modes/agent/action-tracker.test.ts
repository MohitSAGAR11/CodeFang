import { describe, expect, test } from "bun:test";
import { ActionTracker } from "./action-tracker.ts";
import { isMutationType } from "./types.ts";

describe("ActionTracker", () => {
  test("assigns an id and timestamp to every entry", () => {
    const tracker = new ActionTracker();
    const a = tracker.log({
      type: "file_create",
      path: "a.ts",
      details: { after: "x" },
      status: "pending",
    });

    expect(a.id).toBe("action_0");
    expect(a.timestamp).toBeInstanceOf(Date);
  });

  test("keeps ids unique across entries", () => {
    const tracker = new ActionTracker();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      ids.add(
        tracker.log({
          type: "code_analysis",
          path: `f${i}.ts`,
          details: {},
          status: "executed",
        }).id,
      );
    }
    expect(ids.size).toBe(5);
  });

  test("copies details so later mutation cannot rewrite history", () => {
    const tracker = new ActionTracker();
    const details = { after: "original" };
    tracker.log({
      type: "file_create",
      path: "a.ts",
      details,
      status: "pending",
    });

    details.after = "tampered";
    expect(tracker.getActions()[0]!.details.after).toBe("original");
  });

  test("pending mutations exclude reads and already-decided actions", () => {
    const tracker = new ActionTracker();
    tracker.log({
      type: "file_create",
      path: "a.ts",
      details: {},
      status: "pending",
    });
    tracker.log({
      type: "code_analysis",
      path: "b.ts",
      details: {},
      status: "executed",
    });
    tracker.log({
      type: "file_modify",
      path: "c.ts",
      details: {},
      status: "approved",
    });

    const pending = tracker.getPendingMutations();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.path).toBe("a.ts");
  });

  test("updateStatus records the decision", () => {
    const tracker = new ActionTracker();
    const a = tracker.log({
      type: "file_create",
      path: "a.ts",
      details: {},
      status: "pending",
    });

    tracker.updateStatus(a.id, "approved", true);
    const stored = tracker.getActions()[0]!;
    expect(stored.status).toBe("approved");
    expect(stored.userApproved).toBe(true);
    expect(tracker.getPendingMutations()).toHaveLength(0);
  });

  test("updateStatus on an unknown id is a no-op", () => {
    const tracker = new ActionTracker();
    tracker.log({
      type: "file_create",
      path: "a.ts",
      details: {},
      status: "pending",
    });

    expect(() => tracker.updateStatus("nope", "approved", true)).not.toThrow();
    expect(tracker.getActions()[0]!.status).toBe("pending");
  });
});

describe("isMutationType", () => {
  test.each([
    ["file_create"],
    ["file_modify"],
    ["file_delete"],
    ["folder_create"],
    ["tool_execute"],
  ] as const)("%s needs approval", (type) => {
    expect(isMutationType(type)).toBe(true);
  });

  test("code_analysis is read-only and needs no approval", () => {
    expect(isMutationType("code_analysis")).toBe(false);
  });
});
