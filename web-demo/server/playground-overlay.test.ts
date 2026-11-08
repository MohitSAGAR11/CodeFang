import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ActionTracker } from "../../modes/agent/action-tracker.ts";
import { ToolExecutor } from "../../modes/agent/tool-executor.ts";
import { MemoryFS } from "./memory-fs.ts";
import { applyDecisions, buildReviewGroups } from "./review.ts";
import { createPlaygroundTools, FORBIDDEN_WEB_TOOLS, playgroundAgentConfig } from "./web-tools.ts";

const caps = { fileMaxBytes: 1024, overlayMaxBytes: 4096 };

function setup(write = true) {
  const repo = new MemoryFS("demo", [
    ["src/app.ts", "export const v = 1;\n"],
    ["src/old.ts", "legacy\n"],
  ]);
  const tracker = new ActionTracker();
  const executor = new ToolExecutor(tracker, playgroundAgentConfig("demo", write, caps), repo);
  return { repo, tracker, executor };
}

describe("overlay over the virtual repo", () => {
  test("staged writes do not reach the repo before review", () => {
    const { repo, executor } = setup();
    executor.modifyFile("src/app.ts", "export const v = 2;\n");
    executor.createFile("src/new.ts", "new\n");
    executor.deleteFile("src/old.ts");

    expect(repo.readText("src/app.ts")).toBe("export const v = 1;\n");
    expect(repo.stat("src/new.ts")).toBeUndefined();
    expect(repo.stat("src/old.ts")?.isFile).toBe(true);
  });

  test("the agent reads back its own staged edits", () => {
    const { executor } = setup();
    executor.modifyFile("src/app.ts", "staged\n");
    expect(executor.readFile("src/app.ts")).toBe("staged\n");
    executor.deleteFile("src/old.ts");
    expect(() => executor.readFile("src/old.ts")).toThrow(/not found/);
  });

  test("approve applies only approved files; reject discards", () => {
    const { repo, tracker, executor } = setup();
    executor.modifyFile("src/app.ts", "export const v = 2;\n");
    executor.createFile("src/new.ts", "new\n");

    const groups = buildReviewGroups(tracker);
    const app = groups.find((g) => g.path === "src/app.ts")!;
    const created = groups.find((g) => g.path === "src/new.ts")!;
    expect(app.change).toBe("modified");
    expect(created.change).toBe("created");

    const result = applyDecisions(tracker, executor, groups, { [app.id]: "approve", [created.id]: "reject" });

    expect(repo.readText("src/app.ts")).toBe("export const v = 2;\n");
    expect(repo.stat("src/new.ts")).toBeUndefined();
    expect(result.applied).toEqual(["src/app.ts"]);
    expect(result.rejected).toEqual(["src/new.ts"]);
    expect(result.patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(result.patch).toContain("-export const v = 1;");
    expect(result.patch).toContain("+export const v = 2;");
    expect(tracker.getPendingMutations()).toHaveLength(0);
  });

  test("patch headers are git-apply compatible for created and deleted files", () => {
    const { tracker, executor } = setup();
    executor.createFile("docs/x.md", "hi\n");
    executor.deleteFile("src/old.ts");
    const groups = buildReviewGroups(tracker);
    const decisions = Object.fromEntries(groups.map((g) => [g.id, "approve" as const]));
    const { patch } = applyDecisions(tracker, executor, groups, decisions);
    expect(patch).toContain("new file mode 100644\n--- /dev/null\n+++ b/docs/x.md");
    expect(patch).toContain("deleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null");
  });

  test("a file created then deleted in one run is not offered for review", () => {
    const { tracker, executor } = setup();
    executor.createFile("tmp.ts", "x");
    executor.deleteFile("tmp.ts");
    expect(buildReviewGroups(tracker)).toHaveLength(0);
  });

  test("approving never writes to the real disk", () => {
    const { tracker, executor } = setup();
    const marker = `codefang-web-marker-${crypto.randomUUID()}.ts`;
    executor.createFile(marker, "should stay virtual");
    const groups = buildReviewGroups(tracker);
    applyDecisions(tracker, executor, groups, { [groups[0]!.id]: "approve" });
    expect(fs.existsSync(path.join(process.cwd(), marker))).toBe(false);
  });

  test("traversal is rejected by every file tool", () => {
    const { executor } = setup();
    expect(() => executor.readFile("../package.json")).toThrow(/escapes workspace/);
    expect(() => executor.createFile("../evil.ts", "x")).toThrow(/escapes workspace/);
    expect(() => executor.modifyFile("/etc/hosts", "x")).toThrow(/escapes workspace/);
    expect(() => executor.listFiles("..", false)).toThrow(/escapes workspace/);
    expect(() => executor.searchFiles("C:\\", "*")).toThrow(/escapes workspace/);
  });

  test("write caps bound what a run can stage", () => {
    const { executor } = setup();
    expect(() => executor.createFile("big.ts", "x".repeat(2000))).toThrow(/too large/);
    executor.createFile("a.ts", "x".repeat(1000));
    executor.createFile("b.ts", "x".repeat(1000));
    executor.createFile("c.ts", "x".repeat(1000));
    executor.createFile("d.ts", "x".repeat(1000));
    expect(() => executor.createFile("e.ts", "x".repeat(1000))).toThrow(/Staging area is full/);
  });

  test(".env files stay invisible in the virtual repo too", () => {
    const repo = new MemoryFS("demo", [[".env", "SECRET=1"]]);
    const executor = new ToolExecutor(new ActionTracker(), playgroundAgentConfig("demo", true, caps), repo);
    expect(() => executor.readFile(".env")).toThrow(/excluded by policy/);
  });
});

describe("no host access in web mode", () => {
  test("shell and skill tools are not exposed, in any mode", () => {
    for (const write of [true, false]) {
      for (const firecrawl of [true, false]) {
        const { executor, tracker } = setup(write);
        const names = Object.keys(createPlaygroundTools(executor, tracker, { write, firecrawl }));
        for (const forbidden of FORBIDDEN_WEB_TOOLS) expect(names).not.toContain(forbidden);
      }
    }
  });

  test("read-only mode exposes no write tools", () => {
    const { executor, tracker } = setup(false);
    const names = Object.keys(createPlaygroundTools(executor, tracker, { write: false, firecrawl: false }));
    expect(names.sort()).toEqual(["analyze_codebase", "list_files", "read_file", "search_files"]);
  });

  test("the executor refuses shell and skills even if called directly", () => {
    const { executor } = setup();
    expect(() => executor.queueShell("whoami")).toThrow(/disabled/);
    expect(() => executor.listSkills()).toThrow(/disabled/);
    expect(() => executor.readSkill("/etc/passwd")).toThrow(/disabled/);
  });

  test("an approved shell action smuggled into the log is never run", () => {
    const { tracker, executor } = setup();
    const marker = path.join(process.cwd(), `codefang-shell-${crypto.randomUUID()}`);
    tracker.log({
      type: "tool_execute",
      path: "shell",
      details: { command: `echo x > "${marker}"` },
      status: "approved",
    });
    const { errors } = executor.applyApprovedFromTracker();
    expect(errors.join()).toMatch(/shell disabled/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("search_files glob matcher", () => {
  test("keeps the same semantics: ** spans folders, * stays in one segment", async () => {
    const { globMatch } = await import("../../modes/agent/tool-executor.ts");
    expect(globMatch("**/*.ts", "src/deep/a.ts")).toBe(true);
    expect(globMatch("*.ts", "src/a.ts")).toBe(false);
    expect(globMatch("*.ts", "a.TS")).toBe(true);
    expect(globMatch("src/?.ts", "src/a.ts")).toBe(true);
    expect(globMatch("src/*", "src/a/b.ts")).toBe(false);
  });

  test("a pathological pattern finishes fast (no catastrophic backtracking)", async () => {
    const { globMatch } = await import("../../modes/agent/tool-executor.ts");
    const evil = `${"**a".repeat(40)}b`;
    const started = performance.now();
    expect(globMatch(evil, "a".repeat(200))).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("overlong patterns are refused", () => {
    const { executor } = setup();
    expect(() => executor.searchFiles(".", "*".repeat(300))).toThrow(/too long/);
  });

  test("exclusion applies to the resolved path, not just the raw string", () => {
    const repo = new MemoryFS("demo", [["dir/.env", "SECRET=1"]]);
    const executor = new ToolExecutor(new ActionTracker(), playgroundAgentConfig("demo", true, caps), repo);
    expect(() => executor.readFile("dir\\.env")).toThrow(/excluded by policy/);
    expect(() => executor.readFile(" dir/.env")).toThrow(/excluded by policy/);
  });
});
