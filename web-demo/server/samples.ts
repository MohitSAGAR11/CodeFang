import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { buildRepo, type RawEntry, type RepoLimits } from "./repo-source.ts";
import type { MemoryFS } from "./memory-fs.ts";

const manifestSchema = z.object({
  name: z.string(),
  tagline: z.string(),
  language: z.string(),
  order: z.number().optional(),
  prompts: z.object({
    ask: z.array(z.string()).default([]),
    plan: z.array(z.string()).default([]),
    agent: z.array(z.string()).default([]),
  }),
});

export type SampleManifest = z.infer<typeof manifestSchema>;

export interface Sample {
  id: string;
  manifest: SampleManifest;
  /** Read-only template; sessions get a clone. */
  repo: MemoryFS;
}

const MANIFEST = "sample.json";

function* walk(root: string, dir = root): Generator<RawEntry> {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(root, full);
    else if (ent.isFile() && !(dir === root && ent.name === MANIFEST)) {
      yield {
        path: path.relative(root, full).split(path.sep).join("/"),
        data: new Uint8Array(fs.readFileSync(full)),
      };
    }
  }
}

/** Load bundled sample repos once at startup. */
export function loadSamples(dir: string, limits: RepoLimits): Map<string, Sample> {
  const out = new Map<string, Sample>();
  if (!fs.existsSync(dir)) return out;

  const found: Sample[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || !/^[a-z0-9-]+$/.test(ent.name)) continue;
    const root = path.join(dir, ent.name);
    const manifestPath = path.join(root, MANIFEST);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = manifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    found.push({ id: ent.name, manifest, repo: buildRepo(ent.name, walk(root), limits) });
  }
  found.sort((a, b) => (a.manifest.order ?? 99) - (b.manifest.order ?? 99));
  for (const s of found) out.set(s.id, s);
  return out;
}
