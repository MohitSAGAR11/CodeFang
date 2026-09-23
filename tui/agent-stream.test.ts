import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { renderAgentStream, toolLabel } from "./agent-stream.ts";
import { Spinner } from "./spinner.ts";

/**
 * The renderer writes to the real terminal, so swallow its output and keep
 * what it wrote for assertions.
 */
let written: string[];
let restore: () => void;

beforeEach(() => {
  written = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;

  process.stdout.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = (...args: unknown[]) => {
    written.push(args.map(String).join(" ") + "\n");
  };

  restore = () => {
    process.stdout.write = origWrite;
    console.log = origLog;
  };
});

afterEach(() => restore());

const output = () => written.join("");

describe("toolLabel", () => {
  test("maps known tools to a human status", () => {
    expect(toolLabel("read_file")).toBe("Reading file…");
    expect(toolLabel("web_search")).toBe("Searching the web…");
  });

  test("falls back for an unknown tool", () => {
    expect(toolLabel("some_future_tool")).toBe("Working…");
  });
});

describe("renderAgentStream", () => {
  test("returns the concatenated response text", async () => {
    async function* stream() {
      yield { type: "text-delta", text: "Hello " };
      yield { type: "text-delta", text: "world." };
    }

    const text = await renderAgentStream(stream(), new Spinner());
    expect(text).toBe("Hello world.");
  });

  test("stops the spinner on the first text delta, not after the stream", async () => {
    const spinner = new Spinner();
    const activeWhenTextArrived: boolean[] = [];

    async function* stream() {
      yield { type: "tool-call", toolName: "read_file", input: { path: "a.ts" } };
      activeWhenTextArrived.push(spinner.isActive); // still working
      yield { type: "text-delta", text: "answer" };
      activeWhenTextArrived.push(spinner.isActive); // must be stopped now
      yield { type: "text-delta", text: " continues" };
    }

    spinner.start("Thinking…");
    await renderAgentStream(stream(), spinner);

    expect(activeWhenTextArrived).toEqual([true, false]);
    expect(spinner.isActive).toBe(false);
  });

  test("leaves the spinner stopped once the stream ends", async () => {
    const spinner = new Spinner();
    async function* stream() {
      yield { type: "tool-call", toolName: "list_files", input: { path: "." } };
    }

    spinner.start("Thinking…");
    await renderAgentStream(stream(), spinner);
    expect(spinner.isActive).toBe(false);
  });

  test("logs each tool call with its most useful argument", async () => {
    async function* stream() {
      yield {
        type: "tool-call",
        toolName: "modify_file",
        input: { path: "modes/cli.ts", content: "x".repeat(500) },
      };
    }

    await renderAgentStream(stream(), new Spinner());
    expect(output()).toContain("modify_file");
    expect(output()).toContain("modes/cli.ts");
    // The bulky argument must not be dumped to the terminal.
    expect(output()).not.toContain("xxxxxxxxxx");
  });

  test("truncates a long argument preview", async () => {
    const longPath = "src/" + "nested/".repeat(30) + "file.ts";
    async function* stream() {
      yield { type: "tool-call", toolName: "read_file", input: { path: longPath } };
    }

    await renderAgentStream(stream(), new Spinner());
    expect(output()).toContain("…");
    expect(output()).not.toContain(longPath);
  });

  test("reports a stream error without throwing", async () => {
    async function* stream() {
      yield { type: "error", error: new Error("model exploded") };
    }

    const text = await renderAgentStream(stream(), new Spinner());
    expect(text).toBe("");
    expect(output()).toContain("model exploded");
  });

  test("ignores empty deltas and unknown part types", async () => {
    async function* stream() {
      yield { type: "start-step" };
      yield { type: "text-delta", text: "" };
      yield { type: "reasoning-delta", text: "internal" };
      yield { type: "text-delta", text: "real" };
    }

    const text = await renderAgentStream(stream(), new Spinner());
    expect(text).toBe("real");
  });

  test("handles a run that produces no text at all", async () => {
    async function* stream() {
      yield { type: "tool-call", toolName: "analyze_codebase", input: { path: "." } };
      yield { type: "tool-result" };
    }

    const text = await renderAgentStream(stream(), new Spinner());
    expect(text).toBe("");
  });
});
