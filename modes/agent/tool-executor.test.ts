import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutor } from "./tool-executor.ts";
import { ActionTracker } from "./action-tracker.ts";
import { defaultAgentConfig, type AgentConfig } from "./types.ts";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(tmpdir(), "codefang-test-"));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function setup(tools?: Partial<AgentConfig["tools"]>) {
  const base = defaultAgentConfig();
  const config: AgentConfig = {
    ...base,
    codebasePath: ws,
    tools: { ...base.tools, ...tools },
  };
  const tracker = new ActionTracker();
  return { config, tracker, executor: new ToolExecutor(tracker, config) };
}

const write = (rel: string, content: string) => {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
};

const read = (rel: string) => fs.readFileSync(path.join(ws, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ws, rel));

const approveAll = (tracker: ActionTracker) => {
  for (const a of tracker.getPendingMutations()) {
    tracker.updateStatus(a.id, "approved", true);
  }
};

// ---------------------------------------------------------------------------
// The security boundary: nothing may resolve outside the workspace.
// ---------------------------------------------------------------------------
describe("workspace jail", () => {
  test("rejects relative traversal on read", () => {
    const { executor } = setup();
    expect(() => executor.readFile("../outside.txt")).toThrow(
      /escapes workspace/,
    );
  });

  test("rejects traversal buried mid-path", () => {
    const { executor } = setup();
    expect(() => executor.readFile("src/../../outside.txt")).toThrow(
      /escapes workspace/,
    );
  });

  test("rejects absolute paths outside the root", () => {
    const { executor } = setup();
    // Resolves to <drive>:/etc/passwd on Windows, /etc/passwd elsewhere --
    // outside the workspace either way.
    expect(() => executor.readFile(path.resolve("/etc/passwd"))).toThrow(
      /escapes workspace/,
    );
  });

  test("refuses to stage a write outside the root", () => {
    const { executor, tracker } = setup();
    expect(() => executor.createFile("../evil.ts", "pwned")).toThrow(
      /escapes workspace/,
    );
    expect(tracker.getPendingMutations()).toHaveLength(0);
  });

  test("allows a nested path inside the root", () => {
    const { executor } = setup();
    write("src/deep/ok.ts", "fine");
    expect(executor.readFile("src/deep/ok.ts")).toBe("fine");
  });
});

// ---------------------------------------------------------------------------
describe("exclusion policy", () => {
  test.each([
    ["node_modules/left-pad/index.js"],
    ["src/node_modules/sneaky.ts"],
    [".git/config"],
    ["dist/bundle.js"],
    ["debug.log"],
    [".env"],
    [".env.local"],
  ])("refuses %s", (rel) => {
    const { executor } = setup();
    expect(() => executor.readFile(rel)).toThrow(/excluded by policy/);
  });

  test("does not over-match names that merely contain a pattern", () => {
    const { executor } = setup();
    write("environment.ts", "keep me");
    write("distribution.ts", "keep me too");
    expect(executor.readFile("environment.ts")).toBe("keep me");
    expect(executor.readFile("distribution.ts")).toBe("keep me too");
  });

  test("excluded paths stay out of listings", () => {
    const { executor } = setup();
    write("keep.ts", "x");
    write("node_modules/pkg/index.js", "x");
    write("notes.log", "x");
    const listing = executor.listFiles(".", true);
    expect(listing).toContain("keep.ts");
    expect(listing).not.toContain("node_modules");
    expect(listing).not.toContain("notes.log");
  });
});

// ---------------------------------------------------------------------------
describe("read guards", () => {
  test("refuses files over the size cap", () => {
    const { executor, config } = setup();
    config.maxFileSizeToRead = 8;
    write("big.ts", "way more than eight bytes");
    expect(() => executor.readFile("big.ts")).toThrow(/too large/);
  });

  test("reports a missing file", () => {
    const { executor } = setup();
    expect(() => executor.readFile("ghost.ts")).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Staging: mutations live in RAM until applied.
// ---------------------------------------------------------------------------
describe("staging", () => {
  test("create does not touch disk before approval", () => {
    const { executor } = setup();
    executor.createFile("new.ts", "hello");
    expect(exists("new.ts")).toBe(false);
  });

  test("modify does not touch disk before approval", () => {
    const { executor } = setup();
    write("existing.ts", "original");
    executor.modifyFile("existing.ts", "changed");
    expect(read("existing.ts")).toBe("original");
  });

  test("delete does not touch disk before approval", () => {
    const { executor } = setup();
    write("doomed.ts", "still here");
    executor.deleteFile("doomed.ts");
    expect(exists("doomed.ts")).toBe(true);
  });

  test("clearStaging discards everything unwritten", () => {
    const { executor } = setup();
    executor.createFile("new.ts", "hello");
    executor.clearStaging();
    expect(executor.getEffectiveText("new.ts")).toBeUndefined();
    expect(exists("new.ts")).toBe(false);
  });

  test("a staged write is visible to later staged operations", () => {
    const { executor } = setup();
    executor.createFile("staged.ts", "v1");
    // modify_file resolves through the overlay, so it can edit a file that
    // only exists in staging.
    expect(() => executor.modifyFile("staged.ts", "v2")).not.toThrow();
    expect(executor.getEffectiveText("staged.ts")).toBe("v2");
  });

  test("read_file reads back a file that was only staged", () => {
    const { executor } = setup();
    executor.createFile("staged.ts", "from overlay");
    expect(executor.readFile("staged.ts")).toBe("from overlay");
  });

  test("read_file returns the staged version, not the version on disk", () => {
    const { executor } = setup();
    write("edited.ts", "on disk");
    executor.modifyFile("edited.ts", "in overlay");
    expect(executor.readFile("edited.ts")).toBe("in overlay");
    expect(read("edited.ts")).toBe("on disk");
  });

  test("read_file refuses a file staged for deletion", () => {
    const { executor } = setup();
    write("doomed.ts", "still on disk");
    executor.deleteFile("doomed.ts");
    expect(() => executor.readFile("doomed.ts")).toThrow(/not found/);
  });

  test("read_file applies the size cap to staged content too", () => {
    const { executor, config } = setup();
    config.maxFileSizeToRead = 8;
    executor.createFile("big.ts", "way more than eight bytes");
    expect(() => executor.readFile("big.ts")).toThrow(/too large/);
  });

  test("read_file still enforces the jail and exclusions on staged paths", () => {
    const { executor } = setup();
    expect(() => executor.readFile("../escape.ts")).toThrow(
      /escapes workspace/,
    );
    expect(() => executor.readFile(".env")).toThrow(/excluded by policy/);
  });

  test("a staged delete hides the file from later staged operations", () => {
    const { executor } = setup();
    write("gone.ts", "bye");
    executor.deleteFile("gone.ts");
    expect(executor.getEffectiveText("gone.ts")).toBeUndefined();
    expect(() => executor.modifyFile("gone.ts", "x")).toThrow(/not found/);
  });

  test("refuses to create over an existing file", () => {
    const { executor } = setup();
    write("taken.ts", "mine");
    expect(() => executor.createFile("taken.ts", "yours")).toThrow(
      /already exists/,
    );
  });

  test("allows recreating a path that was staged for deletion", () => {
    const { executor } = setup();
    write("cycle.ts", "old");
    executor.deleteFile("cycle.ts");
    expect(() => executor.createFile("cycle.ts", "new")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("capability flags", () => {
  test("file creation can be disabled", () => {
    const { executor } = setup({ allowFileCreation: false });
    expect(() => executor.createFile("a.ts", "x")).toThrow(/disabled/);
  });

  test("file modification can be disabled", () => {
    const { executor } = setup({ allowFileModification: false });
    write("a.ts", "x");
    expect(() => executor.modifyFile("a.ts", "y")).toThrow(/disabled/);
    expect(() => executor.deleteFile("a.ts")).toThrow(/disabled/);
  });

  test("folder creation can be disabled", () => {
    const { executor } = setup({ allowFolderCreation: false });
    expect(() => executor.createFolder("sub")).toThrow(/disabled/);
  });

  test("shell execution can be disabled", () => {
    const { executor } = setup({ allowShellExecution: false });
    expect(() => executor.queueShell("whoami")).toThrow(/disabled/);
  });
});

// ---------------------------------------------------------------------------
describe("apply", () => {
  test("writes only approved actions", () => {
    const { executor, tracker } = setup();
    executor.createFile("yes.ts", "kept");
    executor.createFile("no.ts", "dropped");

    const [first, second] = tracker.getPendingMutations();
    tracker.updateStatus(first!.id, "approved", true);
    tracker.updateStatus(second!.id, "rejected", false);

    const { errors } = executor.applyApprovedFromTracker();
    expect(errors).toHaveLength(0);
    expect(read("yes.ts")).toBe("kept");
    expect(exists("no.ts")).toBe(false);
  });

  test("collapses repeated edits to one write per path", () => {
    const { executor, tracker } = setup();
    executor.createFile("churn.ts", "first");
    executor.deleteFile("churn.ts");
    executor.createFile("churn.ts", "final");

    expect(tracker.getPendingMutations()).toHaveLength(3);
    approveAll(tracker);
    executor.applyApprovedFromTracker();

    expect(read("churn.ts")).toBe("final");
  });

  test("applies a delete", () => {
    const { executor, tracker } = setup();
    write("doomed.ts", "bye");
    executor.deleteFile("doomed.ts");
    approveAll(tracker);
    executor.applyApprovedFromTracker();
    expect(exists("doomed.ts")).toBe(false);
  });

  test("creates folders recursively", () => {
    const { executor, tracker } = setup();
    executor.createFolder("a/b/c");
    approveAll(tracker);
    executor.applyApprovedFromTracker();
    expect(fs.statSync(path.join(ws, "a/b/c")).isDirectory()).toBe(true);
  });

  test("creates missing parent directories for a new file", () => {
    const { executor, tracker } = setup();
    executor.createFile("deep/nested/file.ts", "x");
    approveAll(tracker);
    executor.applyApprovedFromTracker();
    expect(read("deep/nested/file.ts")).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// The claim the whole project rests on: an unapproved command never runs.
// ---------------------------------------------------------------------------
describe("shell", () => {
  const MARKER = "echo ok > marker.txt";

  test("queueing does not execute", () => {
    const { executor } = setup();
    executor.queueShell(MARKER);
    expect(exists("marker.txt")).toBe(false);
  });

  test("a pending command is not executed by apply", () => {
    const { executor } = setup();
    executor.queueShell(MARKER);
    executor.applyApprovedFromTracker();
    expect(exists("marker.txt")).toBe(false);
  });

  test("a rejected command is never executed", () => {
    const { executor, tracker } = setup();
    executor.queueShell(MARKER);
    for (const a of tracker.getPendingMutations()) {
      tracker.updateStatus(a.id, "rejected", false);
    }
    executor.applyApprovedFromTracker();
    expect(exists("marker.txt")).toBe(false);
  });

  test("an approved command runs in the workspace", () => {
    const { executor, tracker } = setup();
    executor.queueShell(MARKER);
    approveAll(tracker);
    executor.applyApprovedFromTracker();
    expect(exists("marker.txt")).toBe(true);
  });

  test("a failing command is reported, not thrown", () => {
    const { executor, tracker } = setup();
    executor.queueShell("exit 3");
    approveAll(tracker);
    const { errors } = executor.applyApprovedFromTracker();
    expect(errors.join()).toMatch(/shell exit 3/);
  });
});

// ---------------------------------------------------------------------------
describe("search and listing", () => {
  test("matches a glob and ignores other extensions", () => {
    const { executor } = setup();
    write("a.ts", "alpha");
    write("b.md", "beta");
    write("sub/c.ts", "gamma");

    const hits = executor.searchFiles(".", "*.ts").split("\n");
    expect(hits).toContain("a.ts");
    expect(hits).toContain("sub/c.ts");
    expect(hits).not.toContain("b.md");
  });

  test("filters by file contents", () => {
    const { executor } = setup();
    write("a.ts", "needle");
    write("b.ts", "haystack");
    expect(executor.searchFiles(".", "*.ts", "needle")).toBe("a.ts");
  });

  test("reports no matches explicitly", () => {
    const { executor } = setup();
    expect(executor.searchFiles(".", "*.rs")).toBe("(no matches)");
  });

  test("non-recursive listing stops at the top level", () => {
    const { executor } = setup();
    write("top.ts", "x");
    write("sub/inner.ts", "x");
    const listing = executor.listFiles(".", false);
    expect(listing).toContain("top.ts");
    expect(listing).not.toContain("inner.ts");
  });
});

// ---------------------------------------------------------------------------
describe("skill roots", () => {
  test("refuses a skill path outside the configured roots", () => {
    const { executor } = setup();
    const outside = path.join(ws, "SKILL.md");
    fs.writeFileSync(outside, "# not a real skill", "utf8");
    expect(() => executor.readSkill(outside)).toThrow(/outside skill roots/);
  });

  test("honours SKILLS_DIRS and reads a skill inside it", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "codefang-skills-"));
    const previous = process.env.SKILLS_DIRS;
    process.env.SKILLS_DIRS = root;
    try {
      const { executor } = setup();
      const skill = path.join(root, "demo", "SKILL.md");
      fs.mkdirSync(path.dirname(skill), { recursive: true });
      fs.writeFileSync(skill, "# demo skill", "utf8");

      expect(executor.listSkills()).toContain(skill);
      expect(executor.readSkill(skill)).toBe("# demo skill");
    } finally {
      if (previous === undefined) delete process.env.SKILLS_DIRS;
      else process.env.SKILLS_DIRS = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
