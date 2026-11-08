import { beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { createApi, type ModelFactory } from "./api.ts";
import { loadConfig } from "./config.ts";
import { loadSamples } from "./samples.ts";
import { scriptedModel, type Turn } from "./testing/scripted-model.ts";

process.env.DEMO_QUIET = "1";

const SERVER_KEY = "sk-or-v1-serverkeyserverkeyserverkey";
const USER_KEY = "sk-or-v1-userkeyuserkeyuserkeyuserkey";

const baseEnv = {
  OPENROUTER_API_KEY: SERVER_KEY,
  OPENROUTER_DEFAULT_MODEL: "test/free",
  DEMO_SAMPLES_DIR: path.join(import.meta.dir, "..", "samples"),
  DEMO_RUNS_PER_WINDOW: "3",
  DEMO_GITHUB_IMPORT: "0",
};

interface Harness {
  api: ReturnType<typeof createApi>;
  calls: Array<{ apiKey: string; modelId: string; tools: string[] }>;
  setScript: (turns: Turn[]) => void;
}

function harness(env: Record<string, string> = {}): Harness {
  const config = loadConfig({ ...baseEnv, ...env });
  const samples = loadSamples(config.samplesDir, config.limits);
  const calls: Harness["calls"] = [];
  let script: Turn[] = [{ text: "ok" }];
  const modelFactory: ModelFactory = ({ apiKey, modelId }) => {
    const model = scriptedModel(script);
    const record = { apiKey, modelId, tools: [] as string[] };
    calls.push(record);
    const original = model.doStream.bind(model);
    model.doStream = async (opts) => {
      record.tools = (opts.tools ?? []).map((t) => t.name);
      return original(opts);
    };
    return model;
  };
  return { api: createApi({ config, samples, modelFactory }), calls, setScript: (t) => (script = t) };
}

const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function call(h: Harness, method: string, url: string, body?: unknown, headers?: Record<string, string>, ip = "1.1.1.1") {
  const res = await h.api.handle(req(method, url, body, headers), ip);
  const text = await res.text();
  return { res, text, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
}

function parseSSE(text: string): Array<{ event: string; data: any }> {
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("event:"))
    .map((block) => {
      const [e, d] = block.split("\n");
      return { event: e!.slice(7), data: JSON.parse(d!.slice(6)) };
    });
}

async function newSession(h: Harness, ip = "1.1.1.1") {
  const { json } = await call(h, "POST", "/api/sessions", { sample: "retry-kit" }, undefined, ip);
  return json.data as { id: string; files: Array<{ path: string }> };
}

const fixBackoff = (content: string) =>
  content.replace("return Math.round(capped + random() * spread);", "return Math.min(opts.maxDelayMs, Math.round(capped + random() * spread));");

describe("web playground API", () => {
  let samplesSource = "";
  beforeAll(async () => {
    samplesSource = await Bun.file(path.join(import.meta.dir, "..", "samples", "retry-kit", "src", "backoff.ts")).text();
  });

  test("config lists samples and never leaks the server key", async () => {
    const h = harness();
    const { json, text } = await call(h, "GET", "/api/config");
    expect(json.data.samples.map((s: { id: string }) => s.id)).toEqual(["retry-kit", "ledger", "shorty"]);
    expect(json.data.serverKeyAvailable).toBe(true);
    expect(text).not.toContain(SERVER_KEY);
  });

  test("agent run streams events, stages a diff, and approve updates only the virtual repo", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([
      { tools: [{ name: "read_file", input: { path: "src/backoff.ts" } }] },
      { tools: [{ name: "modify_file", input: { path: "src/backoff.ts", content: fixBackoff(samplesSource) } }] },
      { text: "Capped the jittered delay at `maxDelayMs`." },
    ]);

    const run = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "agent", prompt: "fix the cap bug" });
    expect(run.res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSSE(run.text);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("start");
    expect(types).toContain("tool");
    expect(types).toContain("staged");
    expect(types.at(-2)).toBe("review");
    expect(types.at(-1)).toBe("done");

    const review = events.find((e) => e.event === "review")!.data;
    expect(review.groups).toHaveLength(1);
    expect(review.groups[0]).toMatchObject({ path: "src/backoff.ts", change: "modified", added: 1, removed: 1 });

    // Before approval the repo is untouched.
    const before = await call(h, "GET", `/api/sessions/${s.id}/file?path=src/backoff.ts`);
    expect(before.json.data.content).toBe(samplesSource);

    const approved = await call(h, "POST", `/api/sessions/${s.id}/review`, { decisions: { g0: "approve" } });
    expect(approved.json.data.applied).toEqual(["src/backoff.ts"]);
    expect(approved.json.data.patch).toContain("diff --git a/src/backoff.ts b/src/backoff.ts");
    expect(approved.json.data.session.touched).toEqual(["src/backoff.ts"]);

    const after = await call(h, "GET", `/api/sessions/${s.id}/file?path=src/backoff.ts`);
    expect(after.json.data.content).toContain("Math.min(opts.maxDelayMs");

    // The sample template itself is never mutated.
    const fresh = await newSession(h, "2.2.2.2");
    const pristine = await call(h, "GET", `/api/sessions/${fresh.id}/file?path=src/backoff.ts`, undefined, undefined, "2.2.2.2");
    expect(pristine.json.data.content).toBe(samplesSource);
  });

  test("rejecting discards the staged change", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([{ tools: [{ name: "create_file", input: { path: "NOTES.md", content: "hi\n" } }] }, { text: "done" }]);
    await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "agent", prompt: "add notes" });
    const r = await call(h, "POST", `/api/sessions/${s.id}/review`, { decisions: { g0: "reject" } });
    expect(r.json.data.applied).toEqual([]);
    expect(r.json.data.patch).toBe("");
    const f = await call(h, "GET", `/api/sessions/${s.id}/file?path=NOTES.md`);
    expect(f.res.status).toBe(404);
  });

  test("a run with no edits ends with an empty review", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([{ text: "Nothing to change." }]);
    const run = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "agent", prompt: "look around" });
    const review = parseSSE(run.text).find((e) => e.event === "review")!.data;
    expect(review.groups).toEqual([]);
  });

  test("the model is never offered shell or skill tools", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([{ text: "ok" }]);
    await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "agent", prompt: "x" });
    await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x" });
    const [agentCall, askCall] = h.calls;
    expect(agentCall!.tools).toContain("modify_file");
    for (const c of h.calls) {
      for (const t of ["execute_shell", "list_skills", "read_skill", "fetch_url", "web_search"]) {
        expect(c.tools).not.toContain(t);
      }
    }
    expect(askCall!.tools).not.toContain("modify_file");
  });

  test("a model calling a tool that isn't exposed gets an error, not execution", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([{ tools: [{ name: "execute_shell", input: { command: "whoami" } }] }, { text: "ok" }]);
    const run = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "agent", prompt: "x" });
    const events = parseSSE(run.text);
    expect(events.find((e) => e.event === "tool-done")?.data.ok).toBe(false);
    expect(events.find((e) => e.event === "review")!.data.groups).toEqual([]);
  });

  test("plan mode returns steps, then plan-exec runs only the chosen ones", async () => {
    const h = harness();
    const s = await newSession(h);
    const plan = {
      researchSummary: "retry() has no options for aborting",
      steps: [
        { title: "Add shouldRetry", description: "Add a shouldRetry predicate", complexity: "low" },
        { title: "Add signal", description: "Support AbortSignal", complexity: "medium" },
      ],
    };
    h.setScript([{ text: JSON.stringify(plan) }]);
    const planned = parseSSE((await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "plan", prompt: "improve retry" })).text);
    const planEvent = planned.find((e) => e.event === "plan")!.data.plan;
    expect(planEvent.steps.map((x: { id: string }) => x.id)).toEqual(["step-1", "step-2"]);

    h.setScript([{ tools: [{ name: "create_file", input: { path: "src/should-retry.ts", content: "export {}\n" } }] }, { text: "done" }]);
    const exec = parseSSE(
      (await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "plan-exec", stepIds: ["step-2"] })).text,
    );
    const phases = exec.filter((e) => e.event === "phase").map((e) => e.data.title);
    expect(phases).toEqual(["Add signal"]);
    expect(exec.find((e) => e.event === "review")!.data.groups[0].path).toBe("src/should-retry.ts");
  });

  test("plan-exec without a plan is refused", async () => {
    const h = harness();
    const s = await newSession(h);
    const r = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "plan-exec", stepIds: ["step-1"] });
    expect(r.res.status).toBe(409);
  });

  test("server-key runs are rate limited per IP", async () => {
    const h = harness();
    const s = await newSession(h);
    for (let i = 0; i < 3; i++) {
      const r = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x" });
      expect(r.res.status).toBe(200);
    }
    const blocked = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x" });
    expect(blocked.res.status).toBe(429);
    expect(blocked.json.error.code).toBe("rate_limited");
    expect(Number(blocked.res.headers.get("retry-after"))).toBeGreaterThan(0);

    // Another IP is unaffected.
    const other = await newSession(h, "9.9.9.9");
    const ok = await call(h, "POST", `/api/sessions/${other.id}/runs`, { mode: "ask", prompt: "x" }, undefined, "9.9.9.9");
    expect(ok.res.status).toBe(200);
  });

  test("bring-your-own key is used for that request only and never echoed", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([{ text: "ok" }]);
    const r = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x", model: "anthropic/claude-haiku-5.5" }, {
      "x-openrouter-key": USER_KEY,
    });
    expect(r.res.status).toBe(200);
    expect(h.calls.at(-1)).toMatchObject({ apiKey: USER_KEY, modelId: "anthropic/claude-haiku-5.5" });
    expect(r.text).not.toContain(USER_KEY);
    const session = await call(h, "GET", `/api/sessions/${s.id}`);
    expect(session.text).not.toContain(USER_KEY);
  });

  test("model choice is capped server-side", async () => {
    const h = harness();
    const s = await newSession(h);
    const paid = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x", model: "anthropic/claude-sonnet-5.5" });
    expect(paid.res.status).toBe(400);
    expect(paid.json.error.code).toBe("model_not_allowed");
    const unknown = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x", model: "evil/model" }, {
      "x-openrouter-key": USER_KEY,
    });
    expect(unknown.res.status).toBe(400);
  });

  test("malformed keys and oversized prompts are rejected before any model call", async () => {
    const h = harness();
    const s = await newSession(h);
    const badKey = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x" }, { "x-openrouter-key": "nope" });
    expect(badKey.res.status).toBe(400);
    const long = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x".repeat(5000) });
    expect(long.res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  test("file reads are jailed to the session repo", async () => {
    const h = harness();
    const s = await newSession(h);
    for (const p of ["../../package.json", "/etc/passwd", "C:\\Windows\\win.ini"]) {
      const r = await call(h, "GET", `/api/sessions/${s.id}/file?path=${encodeURIComponent(p)}`);
      expect(r.res.status).toBe(400);
    }
  });

  test("unknown or expired sessions get a clear 404", async () => {
    const h = harness();
    const r = await call(h, "GET", `/api/sessions/${crypto.randomUUID()}`);
    expect(r.res.status).toBe(404);
    expect(r.json.error.code).toBe("session_expired");
  });

  test("POST endpoints require JSON (no simple cross-site form posts)", async () => {
    const h = harness();
    const res = await h.api.handle(
      new Request("http://localhost/api/sessions", { method: "POST", body: "sample=retry-kit", headers: { "content-type": "application/x-www-form-urlencoded" } }),
      "1.1.1.1",
    );
    expect(res.status).toBe(400);
  });

  test("model errors are mapped and scrubbed", async () => {
    const config = loadConfig(baseEnv);
    const samples = loadSamples(config.samplesDir, config.limits);
    const { APICallError } = await import("ai");
    const failing: ModelFactory = () => {
      const m = scriptedModel([]);
      m.doStream = async () => {
        throw new APICallError({
          message: `upstream 429 for key ${SERVER_KEY}`,
          url: "https://openrouter.ai/api/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: false,
        });
      };
      return m;
    };
    const api = createApi({ config, samples, modelFactory: failing });
    const s = (await (await api.handle(req("POST", "/api/sessions", { sample: "ledger" }), "1.1.1.1")).json()).data;
    const res = await api.handle(req("POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x" }), "1.1.1.1");
    const text = await res.text();
    const err = parseSSE(text).find((e) => e.event === "error")!.data;
    expect(err.code).toBe("model_rate_limited");
    expect(text).not.toContain(SERVER_KEY);
  });

  test("a server-wide cap on concurrent runs returns 503", async () => {
    const h = harness({ DEMO_MAX_CONCURRENT_RUNS: "0" });
    const s = await newSession(h);
    const r = await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "ask", prompt: "x" });
    expect(r.res.status).toBe(503);
    expect(r.json.error.code).toBe("capacity");
    expect(h.calls).toHaveLength(0);
  });

  test("quoted env values (docker --env-file) are unwrapped", () => {
    const config = loadConfig({ ...baseEnv, OPENROUTER_DEFAULT_MODEL: " 'test/quoted'", OPENROUTER_API_KEY: '"sk-or-v1-abcdefabcdefabcdef"' });
    expect(config.defaultModel).toBe("test/quoted");
    expect(config.serverKey).toBe("sk-or-v1-abcdefabcdefabcdef");
  });

  test("reset restores the original sample", async () => {
    const h = harness();
    const s = await newSession(h);
    h.setScript([{ tools: [{ name: "delete_file", input: { path: "README.md" } }] }, { text: "done" }]);
    await call(h, "POST", `/api/sessions/${s.id}/runs`, { mode: "agent", prompt: "x" });
    await call(h, "POST", `/api/sessions/${s.id}/review`, { decisions: { g0: "approve" } });
    expect((await call(h, "GET", `/api/sessions/${s.id}/file?path=README.md`)).res.status).toBe(404);
    await call(h, "POST", `/api/sessions/${s.id}/reset`, {});
    expect((await call(h, "GET", `/api/sessions/${s.id}/file?path=README.md`)).res.status).toBe(200);
  });
});
