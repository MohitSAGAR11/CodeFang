import { describe, expect, test } from "bun:test";
import { MemoryFS } from "./memory-fs.ts";

const repo = () =>
  new MemoryFS("demo", [
    ["src/a.ts", "export const a = 1;\n"],
    ["src/deep/b.ts", "b"],
    ["README.md", "# demo"],
  ]);

describe("MemoryFS path jail", () => {
  const escapes = [
    "../outside.txt",
    "src/../../outside.txt",
    "..",
    "/etc/passwd",
    "\\windows\\system32",
    "C:\\Windows\\win.ini",
    "c:/Windows/win.ini",
    "//server/share/x",
    "src/\0/a.ts",
    "..\\..\\secret",
  ];

  for (const p of escapes) {
    test(`rejects ${JSON.stringify(p)}`, () => {
      expect(() => repo().resolve(p)).toThrow(/escapes workspace/);
    });
  }

  test("normalises harmless paths to canonical keys", () => {
    const fs = repo();
    expect(fs.resolve("./src/a.ts")).toBe("src/a.ts");
    expect(fs.resolve("src\\deep\\b.ts")).toBe("src/deep/b.ts");
    expect(fs.resolve("src/deep/../a.ts")).toBe("src/a.ts");
    expect(fs.resolve(".")).toBe("");
    expect(fs.resolve("src/")).toBe("src");
  });

  test("seeding refuses traversal paths", () => {
    expect(() => new MemoryFS("x", [["../evil", "x"]])).toThrow(/escapes workspace/);
  });
});

describe("MemoryFS storage", () => {
  test("lists directories and files one level at a time", () => {
    const fs = repo();
    expect(fs.readdir("")).toEqual([
      { name: "README.md", isDirectory: false },
      { name: "src", isDirectory: true },
    ]);
    expect(fs.readdir("src").map((e) => e.name)).toEqual(["a.ts", "deep"]);
  });

  test("stat distinguishes files, directories and missing paths", () => {
    const fs = repo();
    expect(fs.stat("src")?.isDirectory).toBe(true);
    expect(fs.stat("src/a.ts")?.isFile).toBe(true);
    expect(fs.stat("nope")).toBeUndefined();
  });

  test("enforces the byte cap", () => {
    const fs = new MemoryFS("x", [], { maxFiles: 10, maxBytes: 10 });
    fs.writeText("a", "12345");
    expect(() => fs.writeText("b", "1234567")).toThrow(/size limit/);
    // Overwriting counts the difference, not the sum.
    fs.writeText("a", "1234567890");
    expect(fs.totalBytes).toBe(10);
  });

  test("enforces the file-count cap", () => {
    const fs = new MemoryFS("x", [], { maxFiles: 1, maxBytes: 1000 });
    fs.writeText("a", "1");
    expect(() => fs.writeText("b", "2")).toThrow(/file limit/);
  });

  test("clone is independent", () => {
    const a = repo();
    const b = a.clone();
    b.writeText("src/a.ts", "changed");
    expect(a.readText("src/a.ts")).toBe("export const a = 1;\n");
  });
});
