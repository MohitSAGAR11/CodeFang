import path from "node:path";
import {
  escapeError,
  type DirEntry,
  type FileStat,
  type WorkspaceFS,
} from "../../modes/agent/workspace-fs.ts";

export interface MemoryFSLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface TreeEntry {
  path: string;
  size: number;
}

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * A virtual repo held entirely in RAM.
 *
 * It is the web playground's stand-in for the disk: the agent's tools read
 * from it, approved changes are written to it, and nothing ever reaches the
 * server's real filesystem. Paths are jailed exactly like the disk workspace
 * (absolute paths, drive letters, NUL bytes and `..` escapes all throw).
 */
export class MemoryFS implements WorkspaceFS {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>([""]);
  private bytes = 0;

  constructor(
    readonly label: string,
    initial: Iterable<[string, string]> = [],
    private readonly limits: MemoryFSLimits = {
      maxFiles: 1000,
      maxBytes: 8 * 1024 * 1024,
    },
  ) {
    for (const [p, content] of initial) this.writeText(this.resolve(p), content);
  }

  resolve(rel: string): string {
    if (typeof rel !== "string" || rel.includes("\0")) throw escapeError(String(rel));
    const slashed = rel.trim().replace(/\\/g, "/");
    // Absolute POSIX paths, UNC paths and Windows drive letters never resolve.
    if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) {
      throw escapeError(rel);
    }
    const normalized = path.posix.normalize(slashed || ".");
    if (normalized === ".." || normalized.startsWith("../")) {
      throw escapeError(rel);
    }
    const key = normalized === "." ? "" : normalized.replace(/\/+$/, "");
    return key.replace(/^\.\//, "");
  }

  stat(key: string): FileStat | undefined {
    const file = this.files.get(key);
    if (file !== undefined) {
      return { isFile: true, isDirectory: false, size: byteLength(file) };
    }
    if (this.dirs.has(key)) return { isFile: false, isDirectory: true, size: 0 };
    return undefined;
  }

  readText(key: string): string {
    const file = this.files.get(key);
    if (file === undefined) throw new Error(`File not found: ${key}`);
    return file;
  }

  readdir(key: string): DirEntry[] {
    if (!this.dirs.has(key)) throw new Error(`Not a directory: ${key}`);
    const prefix = key ? `${key}/` : "";
    const seen = new Map<string, boolean>();
    const visit = (p: string, isDir: boolean) => {
      if (!p.startsWith(prefix) || p === key) return;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, seen.get(rest) || isDir);
      else seen.set(rest.slice(0, slash), true);
    };
    for (const d of this.dirs) visit(d, true);
    for (const f of this.files.keys()) visit(f, false);
    return [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, isDirectory]) => ({ name, isDirectory }));
  }

  writeText(key: string, content: string): void {
    if (!key) throw new Error("Cannot write to the workspace root");
    if (this.dirs.has(key)) throw new Error(`Is a directory: ${key}`);
    const previous = this.files.get(key);
    const nextBytes =
      this.bytes - (previous === undefined ? 0 : byteLength(previous)) + byteLength(content);
    const nextFiles = this.files.size + (previous === undefined ? 1 : 0);
    if (nextFiles > this.limits.maxFiles) {
      throw new Error(`Virtual repo file limit reached (${this.limits.maxFiles})`);
    }
    if (nextBytes > this.limits.maxBytes) {
      throw new Error("Virtual repo size limit reached");
    }
    this.addParents(key);
    this.files.set(key, content);
    this.bytes = nextBytes;
  }

  mkdirp(key: string): void {
    if (this.files.has(key)) throw new Error(`Is a file: ${key}`);
    this.addParents(key);
    this.dirs.add(key);
  }

  remove(key: string): void {
    const previous = this.files.get(key);
    if (previous === undefined) return;
    this.files.delete(key);
    this.bytes -= byteLength(previous);
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get fileCount(): number {
    return this.files.size;
  }

  /** Flat, sorted file listing for the UI. */
  tree(): TreeEntry[] {
    return [...this.files.entries()]
      .map(([p, content]) => ({ path: p, size: byteLength(content) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** An independent copy (sessions get their own copy of a sample). */
  clone(label = this.label): MemoryFS {
    const copy = new MemoryFS(label, [], this.limits);
    for (const d of this.dirs) copy.dirs.add(d);
    for (const [p, c] of this.files) copy.files.set(p, c);
    copy.bytes = this.bytes;
    return copy;
  }

  private addParents(key: string): void {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (this.files.has(dir)) throw new Error(`Is a file: ${dir}`);
      this.dirs.add(dir);
    }
  }
}
