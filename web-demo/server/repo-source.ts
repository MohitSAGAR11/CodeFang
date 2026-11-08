import path from "node:path";
import { MemoryFS } from "./memory-fs.ts";

export interface RepoLimits {
  repoMaxFiles: number;
  repoMaxBytes: number;
  fileMaxBytes: number;
}

export class RepoTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoTooLargeError";
  }
}

export class RepoImportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RepoImportError";
  }
}

const TEXT_EXT = new Set(
  (
    ".ts .tsx .js .jsx .mjs .cjs .json .jsonc .md .mdx .txt .css .scss .sass .less .html .htm " +
    ".vue .svelte .astro .yml .yaml .toml .ini .cfg .conf .xml .svg .graphql .gql .proto .sql " +
    ".py .pyi .rb .go .mod .sum .rs .java .kt .kts .swift .c .h .cc .cpp .hpp .cs .fs .php " +
    ".lua .ex .exs .erl .dart .zig .scala .clj .hs .ml .r .jl .sh .bash .zsh .fish .ps1 " +
    ".bat .dockerfile .tf .nix .gradle .properties .csv .rst .tex .lock"
  ).split(" "),
);

const TEXT_NAMES = new Set([
  "dockerfile",
  "makefile",
  "license",
  "licence",
  "readme",
  "changelog",
  "procfile",
  "gemfile",
  "rakefile",
  ".gitignore",
  ".editorconfig",
  ".prettierrc",
  ".npmrc",
  ".nvmrc",
]);

/** Directories and files the playground never imports. */
const SKIP_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "coverage",
]);

export function isImportablePath(p: string): boolean {
  const segments = p.split("/");
  if (segments.some((s) => SKIP_SEGMENTS.has(s))) return false;
  const base = (segments.at(-1) ?? "").toLowerCase();
  if (base.startsWith(".env")) return false;
  if (base.endsWith(".log") || base.endsWith(".min.js") || base.endsWith(".map")) return false;
  if (base === "package-lock.json" || base === "bun.lock" || base === "yarn.lock" || base === "pnpm-lock.yaml") {
    return false;
  }
  return TEXT_EXT.has(path.posix.extname(base)) || TEXT_NAMES.has(base);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Decode only if this really is UTF-8 text (no NUL bytes). */
export function decodeText(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return strictUtf8.decode(data);
  } catch {
    return undefined;
  }
}

export interface RawEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Turn raw entries into a jailed in-memory repo. Non-text files and
 * oversized single files are skipped; exceeding the repo caps rejects the
 * whole import so a visitor gets a clear "too big" instead of a silent cut.
 */
export function buildRepo(label: string, entries: Iterable<RawEntry>, limits: RepoLimits): MemoryFS {
  const repo = new MemoryFS(label, [], {
    maxFiles: limits.repoMaxFiles,
    maxBytes: limits.repoMaxBytes,
  });
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    let key: string;
    try {
      key = repo.resolve(entry.path);
    } catch {
      continue; // traversal attempt inside the archive: drop it
    }
    if (!key || !isImportablePath(key)) continue;
    if (entry.data.byteLength > limits.fileMaxBytes) continue;
    const text = decodeText(entry.data);
    if (text === undefined) continue;

    files += 1;
    bytes += entry.data.byteLength;
    if (files > limits.repoMaxFiles) {
      throw new RepoTooLargeError(
        `This repo has more than ${limits.repoMaxFiles} source files. The playground keeps repos small; try a smaller one.`,
      );
    }
    if (bytes > limits.repoMaxBytes) {
      throw new RepoTooLargeError(
        `This repo has more than ${Math.round(limits.repoMaxBytes / 1024 / 1024)} MB of source. The playground keeps repos small; try a smaller one.`,
      );
    }
    repo.writeText(key, text);
  }

  if (files === 0) throw new RepoImportError("No readable source files found in that repo.");
  return repo;
}
