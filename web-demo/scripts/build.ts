/**
 * Production build of the playground frontend into web-demo/dist.
 * Fonts live in app/public and are registered at runtime (lib/fonts.ts), so
 * they ship as separate cacheable files; public/ is copied next to the bundle.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");

fs.rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "app", "index.html")],
  outdir,
  minify: true,
  sourcemap: "none",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log}\n`);
  process.exit(1);
}

fs.cpSync(path.join(root, "app", "public"), outdir, { recursive: true });

for (const out of result.outputs) {
  process.stdout.write(`${path.relative(root, out.path).padEnd(40)} ${(out.size / 1024).toFixed(1)} KB\n`);
}
