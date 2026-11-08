import type { ToolSet } from "ai";
import type { ActionTracker } from "../../modes/agent/action-tracker.ts";
import { createAgentTools } from "../../modes/agent/agent-tools.ts";
import type { ToolExecutor } from "../../modes/agent/tool-executor.ts";
import { defaultAgentConfig, type AgentConfig } from "../../modes/agent/types.ts";
import { createWebTools } from "../../modes/plan/web-tools.ts";

/** Tools that must never be reachable from the public playground. */
export const FORBIDDEN_WEB_TOOLS = ["execute_shell", "list_skills", "read_skill", "fetch_url"] as const;

export interface PlaygroundToolOptions {
  write: boolean;
  /** Firecrawl search/crawl. Off unless DEMO_WEB_TOOLS=1 and a key is set. */
  firecrawl: boolean;
}

/**
 * The real CodeFang tool set with every host-touching capability removed:
 * no shell, no skills (host disk), no raw fetch_url (SSRF). File tools are
 * backed by the session's in-memory repo through the executor.
 */
export function createPlaygroundTools(
  executor: ToolExecutor,
  tracker: ActionTracker,
  opts: PlaygroundToolOptions,
): ToolSet {
  const tools: ToolSet = {
    ...createAgentTools(executor, { write: opts.write, shell: false, skills: false }),
  };
  if (opts.firecrawl) {
    const { web_search, web_crawl } = createWebTools(tracker);
    Object.assign(tools, { web_search, web_crawl });
  }
  for (const name of FORBIDDEN_WEB_TOOLS) {
    if (name in tools) throw new Error(`refusing to expose ${name} in the playground`);
  }
  return tools;
}

export interface PlaygroundCaps {
  fileMaxBytes: number;
  overlayMaxBytes: number;
}

/** Executor config for a session: shell and skills off at the executor level too. */
export function playgroundAgentConfig(label: string, write: boolean, caps: PlaygroundCaps): AgentConfig {
  const base = defaultAgentConfig();
  return {
    ...base,
    codebasePath: label,
    maxFileSizeToRead: caps.fileMaxBytes,
    maxWriteBytes: caps.fileMaxBytes,
    maxOverlayBytes: caps.overlayMaxBytes,
    tools: {
      allowShellExecution: false,
      allowFileCreation: write,
      allowFileModification: write,
      allowFolderCreation: write,
      allowSkills: false,
    },
  };
}
