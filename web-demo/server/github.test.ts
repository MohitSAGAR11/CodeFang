import { describe, expect, test } from "bun:test";
import { importGithubRepo, parseRepoRef, tarballUrl, type ImportLimits } from "./github.ts";
import { RepoImportError, RepoTooLargeError } from "./repo-source.ts";
import { parseTar } from "./tar.ts";

// --- a tiny tar writer for fixtures --------------------------------------
const enc = new TextEncoder();
function header(name: string, size: number, flag: string): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number) => h.set(enc.encode(s), at);
  put(name.slice(0, 100), 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put(flag, 156);
  put("ustar\0", 257);
  put("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
function tar(entries: Array<{ name: string; body?: string | Uint8Array; flag?: string }>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const body = typeof e.body === "string" ? enc.encode(e.body) : (e.body ?? new Uint8Array());
    parts.push(header(e.name, body.byteLength, e.flag ?? "0"));
    const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512);
    padded.set(body);
    parts.push(padded);
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
const pax = (path: string) => {
  const rec = ` path=${path}\n`;
  let len = rec.length + 2;
  if (String(len).length + rec.length !== len) len = String(len + 1).length + rec.length;
  return `${len}${rec}`;
};

const limits: ImportLimits = {
  repoMaxFiles: 5,
  repoMaxBytes: 10_000,
  fileMaxBytes: 2_000,
  tarballMaxBytes: 100_000,
  tarballMaxUnpackedBytes: 1_000_000,
  importTimeoutMs: 1000,
};

const fakeFetch = (body: Uint8Array | null, init: ResponseInit = {}, onUrl?: (u: string) => void) =>
  (async (url: string | URL | Request) => {
    onUrl?.(String(url));
    return new Response(body ? Bun.gzipSync(body as Uint8Array<ArrayBuffer>) : null, init);
  }) as unknown as typeof fetch;

describe("parseRepoRef", () => {
  test("accepts the common spellings", () => {
    expect(parseRepoRef("vercel/ms")).toEqual({ owner: "vercel", repo: "ms", ref: "HEAD" });
    expect(parseRepoRef("https://github.com/vercel/ms")).toEqual({ owner: "vercel", repo: "ms", ref: "HEAD" });
    expect(parseRepoRef("github.com/vercel/ms.git")).toEqual({ owner: "vercel", repo: "ms", ref: "HEAD" });
    expect(parseRepoRef("https://github.com/a-b/c.d/tree/feat/x")).toEqual({ owner: "a-b", repo: "c.d", ref: "feat/x" });
  });

  const bad = [
    "",
    "http://169.254.169.254/latest/meta-data",
    "https://evil.example.com/owner/repo",
    "file:///etc/passwd",
    "git@github.com:owner/repo.git",
    "owner",
    "owner/repo/blob/main/x",
    "https://github.com/owner/repo/tree/../../etc",
    "own er/repo",
    "owner/..",
    "//github.com/owner/repo",
  ];
  for (const input of bad) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseRepoRef(input)).toThrow(RepoImportError);
    });
  }

  test("only ever targets codeload.github.com", () => {
    expect(tarballUrl(parseRepoRef("vercel/ms"))).toBe("https://codeload.github.com/vercel/ms/tar.gz/HEAD");
  });
});

describe("parseTar", () => {
  test("reads ustar files, dirs and PAX long paths", () => {
    const archive = tar([
      { name: "r-1/", flag: "5" },
      { name: "r-1/a.ts", body: "a" },
      { name: "PaxHeader", body: pax("r-1/very/long/path/name.ts"), flag: "x" },
      { name: "r-1/short", body: "long" },
    ]);
    const entries = [...parseTar(archive)];
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ["r-1/", "dir"],
      ["r-1/a.ts", "file"],
      ["r-1/very/long/path/name.ts", "file"],
    ]);
  });

  test("rejects truncated archives", () => {
    const archive = tar([{ name: "r/a.ts", body: "x".repeat(600) }]).subarray(0, 700);
    expect(() => [...parseTar(archive)]).toThrow(/truncated/);
  });
});

describe("importGithubRepo", () => {
  test("imports text files, drops binaries, junk dirs and traversal entries", async () => {
    const archive = tar([
      { name: "repo-sha/src/index.ts", body: "export {}" },
      { name: "repo-sha/README.md", body: "# hi" },
      { name: "repo-sha/node_modules/x/index.js", body: "nope" },
      { name: "repo-sha/logo.png", body: new Uint8Array([0x89, 0x50, 0, 1]) },
      { name: "repo-sha/../../escape.ts", body: "evil" },
      { name: "repo-sha/.env", body: "SECRET=1" },
    ]);
    let fetched = "";
    const repo = await importGithubRepo(parseRepoRef("o/r"), limits, fakeFetch(archive, {}, (u) => (fetched = u)));
    expect(fetched).toBe("https://codeload.github.com/o/r/tar.gz/HEAD");
    expect(repo.tree().map((f) => f.path)).toEqual(["README.md", "src/index.ts"]);
  });

  test("rejects a repo with too many files", async () => {
    const archive = tar(Array.from({ length: 8 }, (_, i) => ({ name: `r/f${i}.ts`, body: "x" })));
    await expect(importGithubRepo(parseRepoRef("o/r"), limits, fakeFetch(archive))).rejects.toBeInstanceOf(RepoTooLargeError);
  });

  test("rejects an oversized archive by content-length before reading it", async () => {
    const f = (async () =>
      new Response("x", { headers: { "content-length": String(limits.tarballMaxBytes + 1) } })) as unknown as typeof fetch;
    await expect(importGithubRepo(parseRepoRef("o/r"), limits, f)).rejects.toBeInstanceOf(RepoTooLargeError);
  });

  test("cuts off a gzip bomb at the unpacked cap", async () => {
    const zeros = new Uint8Array(limits.tarballMaxUnpackedBytes + 4096);
    await expect(importGithubRepo(parseRepoRef("o/r"), limits, fakeFetch(zeros))).rejects.toBeInstanceOf(RepoTooLargeError);
  });

  test("a download that times out mid-stream becomes a clear import error", async () => {
    const stalled = (async () =>
      new Response(
        new ReadableStream({
          pull: (controller) => controller.error(new DOMException("The operation timed out.", "TimeoutError")),
        }),
      )) as unknown as typeof fetch;
    await expect(importGithubRepo(parseRepoRef("o/r"), limits, stalled)).rejects.toThrow(/took too long/);
  });

  test("maps a 404 to a friendly error", async () => {
    await expect(importGithubRepo(parseRepoRef("o/r"), limits, fakeFetch(null, { status: 404 }))).rejects.toThrow(/not found/);
  });
});
