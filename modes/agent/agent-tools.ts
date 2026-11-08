import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutor } from "./tool-executor";

export interface ToolSetOptions {
  /** create/modify/delete/folder tools. Default true. */
  write?: boolean;
  /** execute_shell. Default true. Always off in the web playground. */
  shell?: boolean;
  /** list_skills/read_skill (read the host disk). Default true. */
  skills?: boolean;
}

/**
 * The agent's tool set. Capabilities that are switched off are not merely
 * disabled at execution time: the tool is absent, so the model never sees it.
 */
export function createAgentTools(
  executor: ToolExecutor,
  opts: ToolSetOptions = {},
) {
  const { write = true, shell = true, skills = true } = opts;
  const all = buildTools(executor);
  const {
    read_file,
    list_files,
    search_files,
    analyze_codebase,
    create_file,
    modify_file,
    delete_file,
    create_folder,
    execute_shell,
    list_skills,
    read_skill,
  } = all;
  return {
    read_file,
    list_files,
    search_files,
    analyze_codebase,
    ...(write ? { create_file, modify_file, delete_file, create_folder } : {}),
    ...(shell ? { execute_shell } : {}),
    ...(skills ? { list_skills, read_skill } : {}),
  };
}

/** Read-only research tools (Ask, Plan research). */
export function createReadOnlyTools(
  executor: ToolExecutor,
  opts: Pick<ToolSetOptions, "skills"> = {},
) {
  return createAgentTools(executor, { ...opts, write: false, shell: false });
}

function buildTools(executor: ToolExecutor) {
  return {
    read_file: tool({
      description:
        "Read a text file from the workspace. Use a path relative to the project root.",
      inputSchema: z.object({
        path: z.string().describe("Relative file path"),
      }),
      execute: async ({ path: p }) => executor.readFile(p),
    }),

    create_file: tool({
      description:
        "Stage creation of a new file (not written until the user approves).",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path: p, content }) => executor.createFile(p, content),
    }),

    modify_file: tool({
      description:
        "Stage a full-file replacement for an existing file (pending approval).",
      inputSchema: z.object({
        path: z.string(),
        content: z.string().describe("Complete new file contents"),
      }),
      execute: async ({ path: p, content }) => executor.modifyFile(p, content),
    }),

    delete_file: tool({
      description: "Stage deletion of a file (pending approval).",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path: p }) => executor.deleteFile(p),
    }),

    create_folder: tool({
      description:
        "Stage creation of a directory tree (pending approval). Uses mkdir -p on apply.",
      inputSchema: z.object({
        path: z.string().describe("Relative directory path"),
      }),
      execute: async ({ path: p }) => executor.createFolder(p),
    }),

    list_files: tool({
      description: "List files and directories under a path.",
      inputSchema: z.object({
        path: z.string(),
        recursive: z.boolean().optional().default(false),
      }),
      execute: async ({ path: p, recursive }) =>
        executor.listFiles(p, recursive),
    }),

    search_files: tool({
      description:
        'Find files matching a glob pattern (e.g. "*.ts", "**/*.md"). Optional content substring filter.',
      inputSchema: z.object({
        root: z.string().describe("Directory to search, relative to root"),
        pattern: z
          .string()
          .max(256)
          .describe("Glob-like pattern using * and ** (forward slashes)"),
        content_contains: z.string().optional(),
      }),
      execute: async ({ root, pattern, content_contains }) =>
        executor.searchFiles(root, pattern, content_contains),
    }),

    analyze_codebase: tool({
      description:
        "Summarize structure: file counts, size, extensions. Read-only.",
      inputSchema: z.object({
        path: z.string().default("."),
      }),
      execute: async ({ path: p }) => executor.analyzeCodebase(p),
    }),

    execute_shell: tool({
      description:
        "Queue a shell command to run in the workspace after user approval. Use with care.",
      inputSchema: z.object({
        command: z.string().describe("Single command; runs with shell: true"),
      }),
      execute: async ({ command }) => executor.queueShell(command),
    }),

    list_skills: tool({
      description:
        "List absolute paths to SKILL.md files under configured skill directories (Cursor / Claude).",
      inputSchema: z.object({}),
      execute: async () => executor.listSkills(),
    }),

    read_skill: tool({
      description:
        "Read a SKILL.md file. Path must be absolute and under skill roots, or use a path returned by list_skills.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path: p }) => executor.readSkill(p),
    }),
  };
}