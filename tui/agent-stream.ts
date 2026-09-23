import { c, GLYPH, truncateEnd } from "./theme.ts";
import type { Spinner } from "./spinner.ts";

/** Human status labels, keyed by tool name. */
const TOOL_LABEL: Record<string, string> = {
  read_file: "Reading file…",
  list_files: "Listing files…",
  search_files: "Searching the codebase…",
  analyze_codebase: "Analyzing the codebase…",
  create_file: "Staging a new file…",
  modify_file: "Staging an edit…",
  delete_file: "Staging a deletion…",
  create_folder: "Staging a folder…",
  execute_shell: "Queueing a command…",
  list_skills: "Looking up skills…",
  read_skill: "Reading a skill…",
  web_search: "Searching the web…",
  web_crawl: "Fetching a page…",
  fetch_url: "Fetching a URL…",
};

const THINKING = "Thinking…";
const GENERATING = "Generating…";

export const toolLabel = (name: string): string =>
  TOOL_LABEL[name] ?? "Working…";

/** Pull the most human-readable argument out of a tool call. */
function argPreview(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const key = ["path", "command", "query", "url", "pattern", "root"].find(
    (k) => typeof o[k] === "string" && o[k],
  );
  const value = key ? String(o[key]) : JSON.stringify(o);
  return truncateEnd(value, 68);
}

interface StreamPart {
  type?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  error?: unknown;
}

/**
 * Drive the spinner from an agent's `fullStream` and print the response.
 *
 * The spinner tracks whichever tool is running, then stops on the very first
 * text delta so streamed prose is never printed over an animation frame.
 * Returns the full response text.
 */
export async function renderAgentStream(
  stream: AsyncIterable<unknown>,
  spinner: Spinner,
): Promise<string> {
  let text = "";
  let streaming = false;
  let dirtyLine = false;

  const breakLine = () => {
    if (dirtyLine) {
      process.stdout.write("\n");
      dirtyLine = false;
    }
  };

  for await (const raw of stream) {
    const part = raw as StreamPart;

    switch (part.type) {
      case "tool-call": {
        const name = part.toolName ?? "tool";
        breakLine();
        streaming = false;
        spinner.log(
          `  ${c.accent(GLYPH.tool)} ${c.response(name)}  ${c.muted(argPreview(part.input))}`,
        );
        spinner.update(toolLabel(name));
        break;
      }

      case "tool-result":
      case "tool-error":
        spinner.update(THINKING);
        break;

      case "text-delta": {
        const delta = part.text ?? "";
        if (!delta) break;
        if (!streaming) {
          // A response is arriving — the spinner's job is over.
          spinner.stop();
          streaming = true;
          console.log();
        }
        text += delta;
        dirtyLine = !delta.endsWith("\n");
        process.stdout.write(c.response(delta));
        break;
      }

      case "finish-step":
        if (!streaming) spinner.update(GENERATING);
        break;

      case "error": {
        breakLine();
        spinner.stop();
        console.log(c.error(`  ${GLYPH.err} ${String(part.error)}`));
        break;
      }
    }
  }

  breakLine();
  spinner.stop();
  return text;
}
