export interface TarEntry {
  path: string;
  type: "file" | "dir" | "other";
  size: number;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();

const str = (buf: Uint8Array, start: number, len: number): string => {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul));
};

const octal = (buf: Uint8Array, start: number, len: number): number => {
  const first = buf[start] ?? 0;
  // Base-256 encoding (high bit set) is only used for entries > 8 GB.
  if (first & 0x80) throw new Error("tar entry too large");
  const text = str(buf, start, len).trim();
  if (!text) return 0;
  const n = parseInt(text, 8);
  if (!Number.isFinite(n) || n < 0) throw new Error("corrupt tar header");
  return n;
};

/** Parse `len key=value\n` PAX records; only `path` matters here. */
function paxPath(data: Uint8Array): string | undefined {
  const text = decoder.decode(data);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space === -1) break;
    const len = parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    i += len;
  }
  return undefined;
}

const isZeroBlock = (buf: Uint8Array, at: number): boolean => {
  for (let i = at; i < at + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
};

/**
 * Minimal ustar/PAX/GNU reader, enough for GitHub tarballs.
 * Yields raw entry paths; callers must jail them before use.
 */
export function* parseTar(buf: Uint8Array): Generator<TarEntry> {
  let offset = 0;
  let longName: string | undefined;

  while (offset + BLOCK <= buf.length) {
    if (isZeroBlock(buf, offset)) return;

    const name = str(buf, offset, 100);
    const size = octal(buf, offset + 124, 12);
    const flag = String.fromCharCode(buf[offset + 156] ?? 0);
    const magic = str(buf, offset + 257, 6);
    const prefix = magic.startsWith("ustar") ? str(buf, offset + 345, 155) : "";

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error("truncated tar archive");
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (flag === "x") {
      longName = paxPath(data) ?? longName;
      continue;
    }
    if (flag === "L") {
      longName = str(data, 0, data.length);
      continue;
    }
    if (flag === "g") continue;

    const fullPath = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = undefined;

    const type = flag === "0" || flag === "\0" ? "file" : flag === "5" ? "dir" : "other";
    yield { path: fullPath, type, size, data };
  }
}
