import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { AgentConfig, ActionLog } from "./types";
import { ActionTracker } from "./action-tracker";
import { DiskFS, joinKey, type WorkspaceFS } from "./workspace-fs";

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".html",
  ".yml",
  ".yaml",
  ".toml",
  ".txt",
]);

const MAX_GLOB_LENGTH = 256;

/**
 * Glob match without regular expressions: `**` spans directories, `*` stays
 * within one segment, `?` is one character; case-insensitive. Dynamic
 * programming keeps it O(pattern × path), so a model-supplied pattern like
 * `**a**a**a…b` can't stall the event loop the way a backtracking regex can.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length > MAX_GLOB_LENGTH) throw new Error("search_files: pattern too long");
  const p = pattern.toLowerCase().replace(/\*{3,}/g, "**");
  const s = path.toLowerCase();
  // prev[j] = does p[0..i) match s[0..j)?
  let prev: boolean[] = new Array(s.length + 1).fill(false);
  prev[0] = true;
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    const cur: boolean[] = new Array(s.length + 1).fill(false);
    if (ch === "*") {
      const deep = p[i + 1] === "*";
      if (deep) i++;
      for (let j = 0; j <= s.length; j++) {
        // Zero characters, or extend a match by one (never across "/" for a single *).
        cur[j] = prev[j] === true || (j > 0 && cur[j - 1] === true && (deep || s[j - 1] !== "/"));
      }
    } else {
      for (let j = 1; j <= s.length; j++) {
        cur[j] = prev[j - 1] === true && (ch === "?" || ch === s[j - 1]);
      }
    }
    prev = cur;
  }
  return prev[s.length] === true;
}

function isProbablyTextFile(filePath: string): boolean {
  const ext = path.posix.extname(filePath).toLowerCase();
  return TEXT_EXT.has(ext) || ext === "";
}

/**
 * The staging overlay plus every tool implementation.
 *
 * Reads and listings go through a `WorkspaceFS` (disk for the terminal,
 * memory for the web playground). Mutations never touch it until
 * `applyApprovedFromTracker` runs on actions the user approved.
 */
export class ToolExecutor {
  private overlay = new Map<string, string>();
  private deleted = new Set<string>();
  private readonly fs: WorkspaceFS;
  private readonly norm = (rel: string) =>
    path.posix.normalize(rel.split(path.sep).join("/")).replace(/^\.\//, "");

  constructor(
    private readonly tracker: ActionTracker,
    private readonly config: AgentConfig,
    workspace?: WorkspaceFS,
  ) {
    this.fs = workspace ?? new DiskFS(config.codebasePath);
  }

  /** Canonical workspace key, or throw if the path escapes the workspace. */
  private resolveSafe(rel: string): string {
    return this.fs.resolve(rel);
  }

  private excluded(relPath: string): boolean {
    const norm = this.norm(relPath);
    const segments = norm.split("/");
    const base = segments[segments.length - 1] ?? "";

    for (const pat of this.config.excludePatterns) {
      if (pat === "*.log" && base.endsWith(".log")) return true;
      if (pat === ".env*" && base.startsWith(".env")) return true;
      if (pat.includes("*")) continue;
      if (segments.includes(pat) || norm === pat || norm.startsWith(`${pat}/`))
        return true;
    }
    return false;
  }

  private assertNotExcluded(rel: string, op: string): void {
    // Check the canonical key too: "dir\.env" or " .env" resolve to an
    // excluded path even though the raw string doesn't look like one.
    if (this.excluded(rel) || this.excluded(this.resolveSafe(rel))) {
      throw new Error(`${op}: path is excluded by policy: ${rel}`);
    }
  }

  /** Optional per-write and whole-overlay caps (set by the web playground). */
  private assertWithinWriteCaps(key: string, content: string): void {
    const size = Buffer.byteLength(content, "utf8");
    const { maxWriteBytes, maxOverlayBytes } = this.config;
    if (maxWriteBytes !== undefined && size > maxWriteBytes) {
      throw new Error(`Write too large: ${key} (${size} bytes)`);
    }
    if (maxOverlayBytes !== undefined) {
      let total = size;
      for (const [k, v] of this.overlay) {
        if (k !== key) total += Buffer.byteLength(v, "utf8");
      }
      if (total > maxOverlayBytes) {
        throw new Error("Staging area is full for this session");
      }
    }
  }

  private isBaseFile(key: string): boolean {
    return this.fs.stat(key)?.isFile === true;
  }

  getEffectiveText(rel: string): string | undefined {
    const key = this.resolveSafe(rel);
    if (this.deleted.has(key)) return undefined;
    if (this.overlay.has(key)) return this.overlay.get(key);
    if (!this.isBaseFile(key)) return undefined;
    return this.fs.readText(key);
  }

  readFile(rel: string): string {
    this.assertNotExcluded(rel, "read_file");
    const key = this.resolveSafe(rel);

    // Staging wins over disk, so the agent can read back what it just wrote
    // — and cannot read what it just staged for deletion.
    if (this.deleted.has(key)) {
      throw new Error(`File not found: ${rel}`);
    }

    const staged = this.overlay.get(key);
    let text: string;

    if (staged !== undefined) {
      if (Buffer.byteLength(staged, "utf8") > this.config.maxFileSizeToRead) {
        throw new Error(`File too large: ${rel}`);
      }
      text = staged;
    } else {
      const st = this.fs.stat(key);
      if (!st?.isFile) {
        throw new Error(`File not found: ${rel}`);
      }
      // Check size before reading, so a huge file is never pulled into memory.
      if (st.size > this.config.maxFileSizeToRead) {
        throw new Error(`File too large: ${rel}`);
      }
      text = this.fs.readText(key);
    }

    this.tracker.log({
      type: "code_analysis",
      path: key,
      details: { after: text, toolName: "read_file" },
      status: "executed",
    });
    return text;
  }

  createFile(rel: string, content: string): string {
    if (!this.config.tools.allowFileCreation)
      throw new Error("File creation disabled");
    this.assertNotExcluded(rel, "create_file");
    const key = this.resolveSafe(rel);
    if (this.isBaseFile(key) && !this.deleted.has(key)) {
      throw new Error(`create_file: already exists: ${rel}`);
    }
    this.assertWithinWriteCaps(key, content);
    this.deleted.delete(key);
    this.overlay.set(key, content);
    this.tracker.log({
      type: "file_create",
      path: key,
      details: { after: content },
      status: "pending",
    });
    return `Staged new file: ${key}`;
  }

  modifyFile(rel: string, content: string): string {
    if (!this.config.tools.allowFileModification)
      throw new Error("File modification disabled");
    this.assertNotExcluded(rel, "modify_file");
    const before = this.getEffectiveText(rel);
    if (before === undefined)
      throw new Error(`modify_file: file not found: ${rel}`);
    const key = this.resolveSafe(rel);
    this.assertWithinWriteCaps(key, content);
    this.overlay.set(key, content);
    this.tracker.log({
      type: "file_modify",
      path: key,
      details: { before, after: content },
      status: "pending",
    });
    return `Staged update: ${key}`;
  }

  deleteFile(rel: string): string {
    if (!this.config.tools.allowFileModification)
      throw new Error("File deletion disabled");
    this.assertNotExcluded(rel, "delete_file");
    const before = this.getEffectiveText(rel);
    if (before === undefined)
      throw new Error(`delete_file: file not found: ${rel}`);
    const key = this.resolveSafe(rel);
    this.overlay.delete(key);
    this.deleted.add(key);
    this.tracker.log({
      type: "file_delete",
      path: key,
      details: { before },
      status: "pending",
    });
    return `Staged delete: ${key}`;
  }

  createFolder(rel: string): string {
    if (!this.config.tools.allowFolderCreation)
      throw new Error("Folder creation disabled");
    this.assertNotExcluded(rel, "create_folder");
    const key = this.resolveSafe(rel);
    this.tracker.log({
      type: "folder_create",
      path: key,
      details: { after: key },
      status: "pending",
    });
    return `Staged folder: ${key}`;
  }

  listFiles(rel: string, recursive: boolean): string {
    this.assertNotExcluded(rel, "list_files");
    const root = this.resolveSafe(rel);
    const st = this.fs.stat(root);
    if (!st) throw new Error(`list_files: not found: ${rel}`);

    const lines: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const ent of this.fs.readdir(dir)) {
        const childKey = joinKey(dir, ent.name);
        if (this.excluded(childKey)) continue;
        if (ent.isDirectory) {
          lines.push(`${prefix}${ent.name}/`);
          if (recursive) walk(childKey, `${prefix}${ent.name}/`);
        } else {
          lines.push(`${prefix}${ent.name}`);
        }
      }
    };

    if (st.isDirectory) walk(root, "");
    else lines.push(root);

    const out = lines.sort().join("\n");
    this.tracker.log({
      type: "code_analysis",
      path: root,
      details: { after: out, toolName: "list_files" },
      status: "executed",
    });
    return out || "(empty)";
  }

  searchFiles(
    rootRel: string,
    globPattern: string,
    contentQuery?: string,
  ): string {
    this.assertNotExcluded(rootRel, "search_files");
    const rootKey = this.resolveSafe(rootRel);
    const st = this.fs.stat(rootKey);
    if (!st) throw new Error(`search_files: root not found: ${rootRel}`);

    const results: string[] = [];
    const glob = globPattern.replace(/\\/g, "/");
    const matches = (p: string) => globMatch(glob, p);

    const walk = (dir: string) => {
      for (const ent of this.fs.readdir(dir)) {
        const relP = joinKey(dir, ent.name);
        if (this.excluded(relP)) continue;
        if (ent.isDirectory) walk(relP);
        else if (matches(relP) || matches(ent.name)) {
          if (contentQuery) {
            if (!isProbablyTextFile(relP)) continue;
            const size = this.fs.stat(relP)?.size ?? 0;
            if (size > this.config.maxFileSizeToRead) continue;
            if (!this.fs.readText(relP).includes(contentQuery)) continue;
          }
          results.push(relP);
        }
      }
    };

    if (st.isDirectory) walk(rootKey);
    else results.push(rootKey);

    const out = [...new Set(results)].sort().join("\n");
    this.tracker.log({
      type: "code_analysis",
      path: rootKey,
      details: { after: out || "(no matches)", toolName: "search_files" },
      status: "executed",
    });
    return out || "(no matches)";
  }

  analyzeCodebase(rootRel: string): string {
    const rootKey = this.resolveSafe(rootRel);
    const st = this.fs.stat(rootKey);
    if (!st) throw new Error(`analyze_codebase: not found: ${rootRel}`);

    let files = 0;
    let dirs = 0;
    const walk = (dir: string) => {
      for (const ent of this.fs.readdir(dir)) {
        const relP = joinKey(dir, ent.name);
        if (this.excluded(relP)) continue;
        if (ent.isDirectory) {
          dirs++;
          walk(relP);
        } else {
          files++;
        }
      }
    };
    if (st.isDirectory) walk(rootKey);
    else files = 1;

    const summary = `Files: ${files} | Directories: ${dirs}`;
    this.tracker.log({
      type: "code_analysis",
      path: rootKey,
      details: { after: summary, toolName: "analyze_codebase" },
      status: "executed",
    });
    return summary;
  }

  queueShell(command: string): string {
    if (!this.config.tools.allowShellExecution)
      throw new Error("Shell execution disabled");
    this.tracker.log({
      type: "tool_execute",
      path: "shell",
      details: { command, toolName: "execute_shell" },
      status: "pending",
    });
    return `Shell queued: ${command}`;
  }

  skillRoots(): string[] {
    const extra =
      process.env.SKILLS_DIRS?.split(/[;]/)
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    return [
      ...extra,
      path.join(homedir(), ".cursor/skills-cursor"),
      path.join(homedir(), ".claude/skills"),
    ];
  }

  /** Skills live on the host's disk, so modes without disk access disable them. */
  private assertSkillsAllowed(): void {
    if (this.config.tools.allowSkills === false)
      throw new Error("Skills are disabled in this mode");
  }

  listSkills(): string {
    this.assertSkillsAllowed();
    const lines: string[] = [];
    for (const root of this.skillRoots()) {
      if (!fs.existsSync(root)) continue;
      const walk = (dir: string) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.name === "SKILL.md") lines.push(full);
        }
      };
      walk(root);
    }
    const out = lines.sort().join("\n");
    this.tracker.log({
      type: "code_analysis",
      path: "skills",
      details: { after: out || "(none)", toolName: "list_skills" },
      status: "executed",
    });
    return out || "(none)";
  }

  readSkill(skillPath: string): string {
    this.assertSkillsAllowed();
    const abs = path.isAbsolute(skillPath)
      ? path.normalize(skillPath)
      : path.normalize(path.resolve(this.config.codebasePath, skillPath));
    const allowed = this.skillRoots().some((root) => {
      const r = path.resolve(root);
      return abs === r || abs.startsWith(r + path.sep);
    });
    if (!allowed) throw new Error("read_skill: outside skill roots");
    const text = fs.readFileSync(abs, "utf8");
    this.tracker.log({
      type: "code_analysis",
      path: abs,
      details: { after: text, toolName: "read_skill" },
      status: "executed",
    });
    return text;
  }

  applyApprovedFromTracker(): { errors: string[] } {
    const errors: string[] = [];
    const all = [...this.tracker.getActions()];

    for (const a of all.filter(
      (x) => x.type === "folder_create" && x.status === "approved",
    )) {
      try {
        this.fs.mkdirp(this.resolveSafe(a.path));
      } catch (e) {
        errors.push(String(e));
      }
    }

    const fileOps = all
      .filter(
        (a) =>
          (a.type === "file_create" ||
            a.type === "file_modify" ||
            a.type === "file_delete") &&
          a.status === "approved",
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const lastByPath = new Map<string, ActionLog>();
    for (const a of fileOps) lastByPath.set(this.norm(a.path), a);

    for (const [p, a] of lastByPath) {
      try {
        const key = this.resolveSafe(p);
        if (a.type === "file_delete") this.fs.remove(key);
        else this.fs.writeText(key, a.details.after ?? "");
      } catch (e) {
        errors.push(String(e));
      }
    }

    for (const a of all.filter(
      (x) => x.type === "tool_execute" && x.status === "approved",
    )) {
      const cmd = a.details.command;
      if (!cmd) continue;
      // Defence in depth: a mode with the shell disabled, or any workspace
      // that is not a real directory, never runs a command.
      if (!this.config.tools.allowShellExecution || !(this.fs instanceof DiskFS)) {
        errors.push(`shell disabled, not run: ${cmd}`);
        continue;
      }
      const r = spawnSync(cmd, {
        shell: true,
        cwd: this.fs.label,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status && r.status !== 0)
        errors.push(`shell exit ${r.status}: ${cmd}`);
    }

    return { errors };
  }

  clearStaging(): void {
    this.overlay.clear();
    this.deleted.clear();
  }
}
