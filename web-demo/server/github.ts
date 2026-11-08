import { parseTar } from "./tar.ts";
import { buildRepo, RepoImportError, RepoTooLargeError, type RawEntry, type RepoLimits } from "./repo-source.ts";
import type { MemoryFS } from "./memory-fs.ts";

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string;
}

export interface ImportLimits extends RepoLimits {
  tarballMaxBytes: number;
  tarballMaxUnpackedBytes: number;
  importTimeoutMs: number;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9._/-]{1,120}$/;

/**
 * Accepts `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)`
 * and `.../tree/<ref>`. Anything else is rejected — the server only ever
 * builds a codeload.github.com URL itself, so no visitor-supplied URL is fetched.
 */
export function parseRepoRef(input: string): RepoRef {
  const raw = input.trim();
  if (!raw || raw.length > 300) throw new RepoImportError("Enter a GitHub repo like owner/name.");

  let rest = raw;
  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(raw);
  if (urlMatch) rest = urlMatch[1] ?? "";
  else if (/[:@]|^\/|\/\//.test(raw)) {
    throw new RepoImportError("Only public github.com repositories can be imported.");
  }

  rest = rest.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = rest.split("/");
  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/i, "");
  let ref = "HEAD";
  if (parts.length > 2) {
    if (parts[2] !== "tree" || parts.length < 4) {
      throw new RepoImportError("Use a repo URL, or a /tree/<branch> URL.");
    }
    ref = parts.slice(3).join("/");
  }

  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") {
    throw new RepoImportError("That doesn't look like a GitHub owner/repo.");
  }
  if (!REF_RE.test(ref) || ref.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new RepoImportError("That branch name isn't supported.");
  }
  return { owner, repo, ref };
}

export function tarballUrl(r: RepoRef): string {
  const ref = r.ref.split("/").map(encodeURIComponent).join("/");
  return `https://codeload.github.com/${r.owner}/${r.repo}/tar.gz/${ref}`;
}

/** Read a stream fully, aborting as soon as it exceeds `max` bytes. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number, what: string): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        throw new RepoTooLargeError(`That repo's ${what} is over ${Math.round(max / 1024 / 1024)} MB. Try a smaller repo.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Strip GitHub's `<repo>-<sha>/` top-level folder. */
function* stripTopLevel(buf: Uint8Array): Generator<RawEntry> {
  for (const entry of parseTar(buf)) {
    if (entry.type !== "file") continue;
    const slash = entry.path.indexOf("/");
    if (slash === -1) continue;
    yield { path: entry.path.slice(slash + 1), data: entry.data };
  }
}

export async function importGithubRepo(
  ref: RepoRef,
  limits: ImportLimits,
  fetchImpl: typeof fetch = fetch,
): Promise<MemoryFS> {
  let res: Response;
  try {
    res = await fetchImpl(tarballUrl(ref), {
      redirect: "error",
      signal: AbortSignal.timeout(limits.importTimeoutMs),
      headers: { "user-agent": "codefang-playground" },
    });
  } catch {
    throw new RepoImportError("Couldn't reach GitHub. Try again in a moment.", 502);
  }

  if (res.status === 404) {
    throw new RepoImportError("Repo or branch not found. Only public repositories work.", 404);
  }
  if (!res.ok || !res.body) {
    throw new RepoImportError(`GitHub returned ${res.status}.`, 502);
  }
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > limits.tarballMaxBytes) {
    res.body.cancel().catch(() => {});
    throw new RepoTooLargeError(`That repo's archive is over ${Math.round(limits.tarballMaxBytes / 1024 / 1024)} MB. Try a smaller repo.`);
  }

  let gz: Uint8Array<ArrayBuffer>;
  try {
    gz = await readCapped(res.body, limits.tarballMaxBytes, "archive");
  } catch (e) {
    if (e instanceof RepoTooLargeError) throw e;
    // The timeout signal also covers the body: a huge repo that GitHub is
    // still generating lands here rather than hanging the request.
    throw new RepoImportError("GitHub took too long to send that repo. It's probably too big for the playground; try a smaller one.", 504);
  }
  // Decompress as a stream so a gzip bomb is cut off at the unpacked cap.
  const unpacked = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  let tar: Uint8Array;
  try {
    tar = await readCapped(unpacked, limits.tarballMaxUnpackedBytes, "unpacked size");
  } catch (e) {
    if (e instanceof RepoTooLargeError) throw e;
    throw new RepoImportError("That archive couldn't be unpacked.", 502);
  }

  try {
    return buildRepo(`${ref.owner}/${ref.repo}`, stripTopLevel(tar), limits);
  } catch (e) {
    if (e instanceof RepoTooLargeError || e instanceof RepoImportError) throw e;
    throw new RepoImportError("That archive couldn't be read.", 502);
  }
}
