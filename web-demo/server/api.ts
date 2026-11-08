import type { LanguageModel } from "ai";
import { z } from "zod";
import type { DemoConfig, StepCaps } from "./config.ts";
import { toPublicError } from "./errors.ts";
import { importGithubRepo, parseRepoRef } from "./github.ts";
import { log } from "./log.ts";
import { DailyBudget, limiterKey, RateLimiter } from "./rate-limit.ts";
import { RepoImportError, RepoTooLargeError } from "./repo-source.ts";
import { applyDecisions } from "./review.ts";
import { executeRun, PlanMissingError, type RunMode } from "./runner.ts";
import type { Sample } from "./samples.ts";
import { SessionLimitError, SessionStore, type Session } from "./sessions.ts";

export type ModelFactory = (opts: { apiKey: string; modelId: string }) => LanguageModel;

export interface ApiDeps {
  config: DemoConfig;
  samples: Map<string, Sample>;
  modelFactory: ModelFactory;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type ErrorCode = string;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(status < 400 ? { ok: true, data } : data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const fail = (status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) =>
  json({ ok: false, error: { code, message } }, status, headers);

const KEY_HEADER = "x-openrouter-key";
const OPENROUTER_KEY_RE = /^sk-or-[A-Za-z0-9_-]{16,200}$/;
const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 8_000;

const createSessionSchema = z.union([
  z.object({ sample: z.string().regex(/^[a-z0-9-]{1,40}$/) }).strict(),
  z.object({ github: z.string().min(1).max(300) }).strict(),
]);

const reviewSchema = z.object({
  decisions: z.record(z.string().regex(/^g\d{1,4}$/), z.enum(["approve", "reject"])),
}).strict();

const retryHeaders = (ms: number) => ({ "retry-after": String(Math.max(1, Math.ceil(ms / 1000))) });

async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  // Requiring JSON forces a CORS preflight for cross-site callers, which this server never approves.
  if (!type.toLowerCase().startsWith("application/json")) throw new BadRequest("Expected application/json.");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest("Request body too large.");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new BadRequest("Request body too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("Malformed JSON.");
  }
}

class BadRequest extends Error {}

export function createApi(deps: ApiDeps) {
  const { config, samples } = deps;
  const L = config.limits;
  const now = deps.now ?? Date.now;

  const store = new SessionStore(
    { ttlMs: L.sessionTtlMs, maxSessions: L.maxSessions, maxPerIp: L.maxSessionsPerIp },
    now,
  );
  const limiters = {
    server: new RateLimiter(L.runsPerWindowServer, L.rateWindowMs, now),
    byok: new RateLimiter(L.runsPerWindowByok, L.rateWindowMs, now),
    sessions: new RateLimiter(L.sessionsPerWindow, L.rateWindowMs, now),
    imports: new RateLimiter(L.importsPerWindow, L.rateWindowMs, now),
  };
  const budget = new DailyBudget(L.dailyServerRunBudget, now);
  // Server-wide concurrency, independent of IP (which can be many or spoofed).
  const active = { runs: 0, imports: 0 };

  const repoCaps = { fileMaxBytes: L.fileMaxBytes, overlayMaxBytes: L.overlayMaxBytes };

  function sessionDTO(s: Session) {
    return {
      id: s.id,
      label: s.label,
      source: s.source,
      files: s.repo.tree(),
      touched: [...s.touched],
      expiresAt: store.expiresAt(s),
      pending: s.pending?.groups ?? null,
      plan: s.plan ?? null,
    };
  }

  function publicCaps(c: StepCaps) {
    return { ask: c.ask, plan: c.plan, agent: c.agent, planExecMaxSelected: c.planExecMaxSelected };
  }

  function configDTO() {
    return {
      defaultModel: config.defaultModel,
      serverModels: config.serverModels,
      byokModels: config.byokModels,
      serverKeyAvailable: !!config.serverKey,
      githubImport: config.githubImport,
      webTools: config.webTools,
      samples: [...samples.values()].map((s) => ({
        id: s.id,
        name: s.manifest.name,
        tagline: s.manifest.tagline,
        language: s.manifest.language,
        fileCount: s.repo.fileCount,
        prompts: s.manifest.prompts,
      })),
      limits: {
        promptMaxChars: L.promptMaxChars,
        server: publicCaps(L.server),
        byok: publicCaps(L.byok),
        runsPerWindow: L.runsPerWindowServer,
        rateWindowMinutes: Math.round(L.rateWindowMs / 60_000),
        repoMaxFiles: L.repoMaxFiles,
        repoMaxMB: Math.round(L.repoMaxBytes / 1024 / 1024),
        sessionTtlMinutes: Math.max(1, Math.round(L.sessionTtlMs / 60_000)),
      },
    };
  }

  async function createSession(req: Request, ip: string): Promise<Response> {
    const parsed = createSessionSchema.safeParse(await readJson(req));
    if (!parsed.success) return fail(400, "bad_request", "Pick a sample or enter a GitHub repo.");

    const rate = limiters.sessions.take(ip);
    if (!rate.ok) return fail(429, "rate_limited", "Too many new playgrounds. Wait a bit.", retryHeaders(rate.retryAfterMs));

    try {
      if ("sample" in parsed.data) {
        const sample = samples.get(parsed.data.sample);
        if (!sample) return fail(404, "unknown_sample", "That sample doesn't exist.");
        const s = store.create(ip, sample.manifest.name, { kind: "sample", id: sample.id }, sample.repo.clone(sample.manifest.name));
        log("session.create", { source: "sample", sample: sample.id, files: s.repo.fileCount });
        return json(sessionDTO(s), 201);
      }

      if (!config.githubImport) return fail(403, "import_disabled", "GitHub import is turned off on this deployment.");
      const ref = parseRepoRef(parsed.data.github);
      const irate = limiters.imports.take(ip);
      if (!irate.ok) {
        return fail(429, "rate_limited", "Too many repo imports. Wait a bit, or use a sample.", retryHeaders(irate.retryAfterMs));
      }
      if (active.imports >= L.maxConcurrentImports) {
        return fail(503, "capacity", "Other repos are importing right now. Try again in a few seconds.", retryHeaders(5000));
      }
      active.imports++;
      let repo;
      try {
        repo = await importGithubRepo(ref, L, deps.fetchImpl);
      } finally {
        active.imports--;
      }
      const s = store.create(ip, `${ref.owner}/${ref.repo}`, { kind: "github", ...ref }, repo);
      log("session.create", { source: "github", files: repo.fileCount, bytes: repo.totalBytes });
      return json(sessionDTO(s), 201);
    } catch (e) {
      if (e instanceof RepoTooLargeError) return fail(413, "repo_too_large", e.message);
      if (e instanceof RepoImportError) return fail(e.status, "import_failed", e.message);
      if (e instanceof SessionLimitError) return fail(503, "capacity", e.message);
      throw e;
    }
  }

  const runSchema = z.object({
    mode: z.enum(["ask", "plan", "plan-exec", "agent"]),
    prompt: z.string().max(L.promptMaxChars).default(""),
    model: z.string().max(120).optional(),
    stepIds: z.array(z.string().regex(/^step-\d{1,2}$/)).max(15).optional(),
  }).strict();

  async function startRun(req: Request, ip: string, s: Session): Promise<Response> {
    const parsed = runSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some((i) => i.code === "too_big");
      return fail(400, "bad_request", tooLong ? `Keep the prompt under ${L.promptMaxChars} characters.` : "Invalid run request.");
    }
    const body = parsed.data;
    const mode = body.mode as RunMode;
    const prompt = body.prompt.trim();
    if (mode !== "plan-exec" && !prompt) return fail(400, "bad_request", "Type a prompt first.");
    if (s.running) return fail(409, "busy", "A run is already in progress for this playground.");
    if (mode === "plan-exec" && !s.plan) return fail(409, "no_plan", "Draft a plan first.");

    // Key: the visitor's own (per request, never stored or logged) or the server's.
    const byokKey = req.headers.get(KEY_HEADER)?.trim();
    if (byokKey && !OPENROUTER_KEY_RE.test(byokKey)) {
      return fail(400, "bad_key_format", "That doesn't look like an OpenRouter key (sk-or-…).");
    }
    const keySource = byokKey ? "byok" : "server";
    const apiKey = byokKey || config.serverKey;
    if (!apiKey) return fail(503, "no_server_key", "This deployment has no shared key. Add your own OpenRouter key to run.");

    const modelId = body.model?.trim() || config.defaultModel;
    const allowed = keySource === "byok" ? config.byokModels : config.serverModels;
    if (!allowed.includes(modelId)) {
      return fail(400, "model_not_allowed", keySource === "byok"
        ? "That model isn't on this playground's list."
        : "That model needs your own OpenRouter key.");
    }

    if (active.runs >= L.maxConcurrentRuns) {
      return fail(503, "capacity", "The playground is busy right now. Try again in a minute.", retryHeaders(30_000));
    }

    const rate = limiters[keySource].take(ip);
    if (!rate.ok) {
      const mins = Math.ceil(rate.retryAfterMs / 60_000);
      return fail(429, "rate_limited", keySource === "server"
        ? `You've used the free runs for now. Try again in ~${mins} min, or add your own OpenRouter key.`
        : `Slow down a little. Try again in ~${mins} min.`, retryHeaders(rate.retryAfterMs));
    }
    if (keySource === "server" && !budget.take()) {
      return fail(429, "daily_budget", "Today's shared demo budget is used up. Add your own OpenRouter key, or come back tomorrow.");
    }

    // A new run supersedes any unreviewed staging.
    if (s.pending) {
      s.pending.executor.clearStaging();
      s.pending = undefined;
    }
    if (mode === "plan") s.plan = undefined;

    const caps = keySource === "byok" ? L.byok : L.server;
    const abort = new AbortController();
    s.running = abort;
    active.runs++;
    const onClientGone = () => abort.abort("cancelled");
    req.signal.addEventListener("abort", onClientGone);
    const timer = setTimeout(() => abort.abort("timeout"), caps.runTimeoutMs);

    const started = now();
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        const emit = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);

        emit("start", {
          mode,
          model: modelId,
          keySource,
          maxSteps: mode === "ask" ? caps.ask : mode === "plan" ? caps.plan : mode === "agent" ? caps.agent : caps.planExecPerStep,
          remaining: rate.remaining,
        });

        let outcome = "ok";
        let steps = 0;
        try {
          const model = deps.modelFactory({ apiKey, modelId });
          const summary = await executeRun(s, { mode, prompt, stepIds: body.stepIds }, {
            model,
            caps,
            repoCaps,
            firecrawl: config.webTools,
            signal: abort.signal,
            emit,
          });
          steps = summary.steps;
          emit("done", summary);
        } catch (e) {
          const reason = abort.signal.aborted ? (abort.signal.reason === "timeout" ? "timeout" : "cancelled") : undefined;
          const pub = e instanceof PlanMissingError
            ? { code: "no_plan", message: e.message }
            : toPublicError(e, [apiKey], reason);
          outcome = pub.code;
          if (pub.code === "internal") log("run.internal_error", { error: e instanceof Error ? e.name : "unknown" });
          emit("error", pub);
        } finally {
          clearInterval(heartbeat);
          clearTimeout(timer);
          req.signal.removeEventListener("abort", onClientGone);
          if (s.running === abort) s.running = undefined;
          active.runs--;
          log("run", { mode, model: modelId, keySource, outcome, steps, ms: now() - started });
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        }
      },
      cancel: () => {
        closed = true;
        abort.abort("cancelled");
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  }

  async function review(req: Request, s: Session): Promise<Response> {
    const parsed = reviewSchema.safeParse(await readJson(req));
    if (!parsed.success) return fail(400, "bad_request", "Invalid review decisions.");
    if (s.running) return fail(409, "busy", "Wait for the run to finish.");
    const pending = s.pending;
    if (!pending) return fail(409, "no_review", "Nothing is waiting for review.");

    const result = applyDecisions(pending.tracker, pending.executor, pending.groups, parsed.data.decisions);
    s.pending = undefined;
    for (const p of result.applied) s.touched.add(p);
    log("review", { applied: result.applied.length, rejected: result.rejected.length });
    return json({ ...result, session: sessionDTO(s) });
  }

  function readFile(url: URL, s: Session): Response {
    const p = url.searchParams.get("path") ?? "";
    let key: string;
    try {
      key = s.repo.resolve(p);
    } catch {
      return fail(400, "bad_path", "Invalid path.");
    }
    const st = s.repo.stat(key);
    const hidden = key.split("/").some((seg) => seg.startsWith(".env"));
    if (!st?.isFile || hidden) return fail(404, "not_found", "File not found.");
    return json({ path: key, content: s.repo.readText(key) });
  }

  async function handle(req: Request, clientIp: string): Promise<Response> {
    const ip = limiterKey(clientIp);
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    try {
      if (parts[0] !== "api") return fail(404, "not_found", "Not found.");

      if (parts.length === 2 && parts[1] === "config" && req.method === "GET") return json(configDTO());
      if (parts.length === 2 && parts[1] === "sessions" && req.method === "POST") return await createSession(req, ip);

      if (parts[1] === "sessions" && parts[2]) {
        if (!/^[0-9a-f-]{36}$/.test(parts[2])) return fail(404, "session_expired", "This playground expired. Start a new one.");
        const s = store.get(parts[2]);
        if (!s) return fail(404, "session_expired", "This playground expired. Start a new one.");
        const action = parts[3];

        if (!action && req.method === "GET") return json(sessionDTO(s));
        if (!action && req.method === "DELETE") {
          store.delete(s.id);
          return json({ deleted: true });
        }
        if (action === "file" && req.method === "GET") return readFile(url, s);
        if (action === "runs" && req.method === "POST") return await startRun(req, ip, s);
        if (action === "cancel" && req.method === "POST") {
          s.running?.abort("cancelled");
          return json({ cancelled: true });
        }
        if (action === "review" && req.method === "POST") return await review(req, s);
        if (action === "review" && req.method === "DELETE") {
          if (s.running) return fail(409, "busy", "Wait for the run to finish.");
          s.pending?.executor.clearStaging();
          s.pending = undefined;
          return json(sessionDTO(s));
        }
        if (action === "reset" && req.method === "POST") {
          if (s.running) return fail(409, "busy", "Wait for the run to finish.");
          s.pending?.executor.clearStaging();
          s.pending = undefined;
          s.plan = undefined;
          s.repo = s.original.clone();
          s.touched.clear();
          return json(sessionDTO(s));
        }
      }
      return fail(404, "not_found", "Not found.");
    } catch (e) {
      if (e instanceof BadRequest) return fail(400, "bad_request", e.message);
      log("api.error", { path: url.pathname, error: e instanceof Error ? e.name : "unknown" });
      return fail(500, "internal", "Something went wrong.");
    }
  }

  return { handle, store, limiters, budget, active };
}
