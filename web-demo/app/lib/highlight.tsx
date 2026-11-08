import type { ReactNode } from "react";

/**
 * A deliberately small highlighter: comments, strings, numbers and keywords
 * for the languages the samples use. Good enough to read; no dependency.
 */
const KEYWORDS: Record<string, string[]> = {
  ts: "import export from as default function return const let var if else for while do switch case break continue new class extends implements interface type enum public private protected readonly static async await try catch finally throw typeof instanceof in of void null undefined true false this super keyof declare namespace".split(" "),
  py: "import from as def return if elif else for while in not and or is None True False class with try except finally raise lambda yield pass break continue global nonlocal async await assert del".split(" "),
  go: "package import func return if else for range switch case default break continue go defer select chan map struct interface type var const nil true false make new len cap append".split(" "),
};

const LANG_BY_EXT: Record<string, keyof typeof KEYWORDS> = {
  ts: "ts", tsx: "ts", js: "ts", jsx: "ts", mjs: "ts", cjs: "ts", json: "ts",
  py: "py", pyi: "py", toml: "py",
  go: "go", mod: "go",
};

export function langOf(path: string): keyof typeof KEYWORDS | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext];
}

const TOKEN_RE: Record<string, RegExp> = {
  ts: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_.]*\b)|(\b[A-Za-z_$][\w$]*\b)/g,
  py: /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|f?"(?:\\.|[^"\\\n])*"|f?'(?:\\.|[^'\\\n])*')|(\b\d[\d_.]*\b)|(\b[A-Za-z_][\w]*\b)/g,
  go: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`[^`]*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_.]*\b)|(\b[A-Za-z_][\w]*\b)/g,
};

/** Highlight a whole file and return one ReactNode array per line. */
export function highlightLines(code: string, path: string): ReactNode[][] {
  const lang = langOf(path);
  const lines: ReactNode[][] = [[]];
  const push = (text: string, cls?: string) => {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1]!;
      line.push(cls ? <span key={line.length} className={cls}>{part}</span> : part);
    });
  };

  if (!lang) {
    push(code);
    return lines;
  }
  const keywords = new Set(KEYWORDS[lang]);
  const re = new RegExp(TOKEN_RE[lang]!.source, "g");
  let last = 0;
  for (const m of code.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) push(code.slice(last, at));
    if (m[1]) push(m[0], "tk-comment");
    else if (m[2]) push(m[0], "tk-string");
    else if (m[3]) push(m[0], "tk-number");
    else if (m[4] && keywords.has(m[0])) push(m[0], "tk-keyword");
    else push(m[0]);
    last = at + m[0].length;
  }
  if (last < code.length) push(code.slice(last));
  return lines;
}
