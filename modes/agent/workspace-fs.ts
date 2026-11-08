import fs from "node:fs";
import path from "node:path";

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

/**
 * The storage underneath the staging overlay.
 *
 * Every path the agent supplies goes through `resolve` first, which returns a
 * canonical workspace-relative POSIX key ("" is the root) or throws
 * `Path escapes workspace`. All other methods take only resolved keys.
 *
 * `DiskFS` is the terminal workspace. The web playground swaps in an
 * in-memory implementation so a public demo never touches the server's disk.
 */
export interface WorkspaceFS {
  /** Human label for prompts (a path on disk, or a repo name). */
  readonly label: string;
  resolve(rel: string): string;
  stat(key: string): FileStat | undefined;
  readText(key: string): string;
  readdir(key: string): DirEntry[];
  writeText(key: string, content: string): void;
  mkdirp(key: string): void;
  remove(key: string): void;
}

export const escapeError = (rel: string) =>
  new Error(`Path escapes workspace: ${rel}`);

export class DiskFS implements WorkspaceFS {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get label(): string {
    return this.root;
  }

  /** Absolute disk path for an already-resolved key. */
  abs(key: string): string {
    return key ? path.join(this.root, ...key.split("/")) : this.root;
  }

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const relCheck = path.relative(this.root, abs);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
      throw escapeError(rel);
    }
    return relCheck.split(path.sep).join("/");
  }

  stat(key: string): FileStat | undefined {
    const abs = this.abs(key);
    if (!fs.existsSync(abs)) return undefined;
    const s = fs.statSync(abs);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  }

  readText(key: string): string {
    return fs.readFileSync(this.abs(key), "utf8");
  }

  readdir(key: string): DirEntry[] {
    return fs
      .readdirSync(this.abs(key), { withFileTypes: true })
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  writeText(key: string, content: string): void {
    const target = this.abs(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }

  mkdirp(key: string): void {
    fs.mkdirSync(this.abs(key), { recursive: true });
  }

  remove(key: string): void {
    fs.rmSync(this.abs(key), { force: true });
  }
}

/** Join a resolved directory key and a child name. */
export const joinKey = (dir: string, name: string): string =>
  dir ? `${dir}/${name}` : name;
