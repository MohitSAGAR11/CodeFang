export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; text: string; oldNo?: number; newNo?: number }
  | { kind: "note"; text: string };

/** Parse a unified patch (as produced by `diff`'s createTwoFilesPatch) into display rows. */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (!inHunk && (line.startsWith("Index:") || /^=+$/.test(line) || line.startsWith("--- ") || line.startsWith("+++ "))) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("\\")) rows.push({ kind: "note", text: line.slice(2) });
    else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}
