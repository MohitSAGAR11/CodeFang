import path from "node:path";

/** Everything the playground can be tuned with, read once from the environment. */
export interface DemoConfig {
  port: number;
  production: boolean;
  serverKey: string | undefined;
  defaultModel: string;
  /** Models a visitor may pick when the run is billed to the server key. */
  serverModels: string[];
  /** Models a visitor may pick with their own OpenRouter key. */
  byokModels: string[];
  samplesDir: string;
  githubImport: boolean;
  webTools: boolean;
  trustProxyHops: number;
  limits: DemoLimits;
}

export interface StepCaps {
  ask: number;
  plan: number;
  agent: number;
  /** Per plan step during execution. */
  planExecPerStep: number;
  /** How many plan steps can be executed in one run. */
  planExecMaxSelected: number;
  maxOutputTokens: number;
  runTimeoutMs: number;
}

export interface DemoLimits {
  promptMaxChars: number;
  server: StepCaps;
  byok: StepCaps;
  rateWindowMs: number;
  runsPerWindowServer: number;
  runsPerWindowByok: number;
  sessionsPerWindow: number;
  importsPerWindow: number;
  dailyServerRunBudget: number;
  sessionTtlMs: number;
  maxSessions: number;
  /** Server-wide caps, whatever the IP or key. */
  maxConcurrentRuns: number;
  maxConcurrentImports: number;
  maxSessionsPerIp: number;
  repoMaxFiles: number;
  repoMaxBytes: number;
  fileMaxBytes: number;
  overlayMaxBytes: number;
  tarballMaxBytes: number;
  tarballMaxUnpackedBytes: number;
  importTimeoutMs: number;
}

const DEFAULT_BYOK_MODELS = [
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5.5",
  "google/gemini-3.8-flash",
  "openai/gpt-5.4-mini",
  "moonshotai/kimi-k2.7-code",
  "qwen/qwen3-coder-next",
  "deepseek/deepseek-v3.2",
  "z-ai/glm-4.7",
];

type Env = Record<string, string | undefined>;

/**
 * `docker run --env-file` passes values verbatim, so `KEY= 'value'` arrives
 * with the space and quotes. Strip both, the way dotenv would.
 */
export const cleanEnv = (raw: string | undefined): string | undefined => {
  const v = raw?.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  return v ? v : undefined;
};

const num = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return n;
};

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const flag = (raw: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());

const unique = (xs: string[]): string[] => [...new Set(xs)];

export function loadConfig(rawEnv: Env = process.env): DemoConfig {
  const env: Env = Object.fromEntries(Object.entries(rawEnv).map(([k, v]) => [k, cleanEnv(v)]));
  const defaultModel = env.OPENROUTER_DEFAULT_MODEL || "openrouter/free";
  const serverModels = unique([defaultModel, ...list(env.DEMO_SERVER_MODELS)]);
  const byokRaw = list(env.DEMO_BYOK_MODELS);
  const byokModels = unique([
    ...serverModels,
    ...(byokRaw.length ? byokRaw : DEFAULT_BYOK_MODELS),
  ]);

  const server: StepCaps = {
    ask: num(env, "DEMO_MAX_STEPS_ASK", 8),
    plan: num(env, "DEMO_MAX_STEPS_PLAN", 8),
    agent: num(env, "DEMO_MAX_STEPS_AGENT", 14),
    planExecPerStep: num(env, "DEMO_MAX_STEPS_PLAN_EXEC", 8),
    planExecMaxSelected: num(env, "DEMO_MAX_PLAN_STEPS", 4),
    maxOutputTokens: num(env, "DEMO_MAX_OUTPUT_TOKENS", 4096),
    runTimeoutMs: num(env, "DEMO_RUN_TIMEOUT_MS", 180_000),
  };
  const byok: StepCaps = {
    ask: 15,
    plan: 15,
    agent: 30,
    planExecPerStep: 15,
    planExecMaxSelected: 10,
    maxOutputTokens: 8192,
    runTimeoutMs: 300_000,
  };

  return {
    port: num(env, "PORT", 8788),
    production: env.NODE_ENV === "production",
    serverKey: env.OPENROUTER_API_KEY,
    defaultModel,
    serverModels,
    byokModels,
    samplesDir: path.resolve(
      env.DEMO_SAMPLES_DIR ?? path.join(process.cwd(), "web-demo", "samples"),
    ),
    githubImport: env.DEMO_GITHUB_IMPORT === undefined ? true : flag(env.DEMO_GITHUB_IMPORT),
    // Firecrawl web tools stay off for the public demo unless explicitly enabled.
    webTools: flag(env.DEMO_WEB_TOOLS) && !!env.FIRECRAWL_API_KEY,
    // Railway puts one proxy in front of the container; trust exactly that hop by default there.
    trustProxyHops: num(env, "TRUST_PROXY_HOPS", env.RAILWAY_ENVIRONMENT ? 1 : 0),
    limits: {
      promptMaxChars: 2000,
      server,
      byok,
      rateWindowMs: num(env, "DEMO_RATE_WINDOW_MS", 15 * 60_000),
      runsPerWindowServer: num(env, "DEMO_RUNS_PER_WINDOW", 6),
      runsPerWindowByok: num(env, "DEMO_RUNS_PER_WINDOW_BYOK", 40),
      sessionsPerWindow: num(env, "DEMO_SESSIONS_PER_WINDOW", 20),
      importsPerWindow: num(env, "DEMO_IMPORTS_PER_WINDOW", 5),
      dailyServerRunBudget: num(env, "DEMO_DAILY_RUN_BUDGET", 150),
      sessionTtlMs: num(env, "DEMO_SESSION_TTL_MS", 30 * 60_000),
      maxSessions: num(env, "DEMO_MAX_SESSIONS", 200),
      maxConcurrentRuns: num(env, "DEMO_MAX_CONCURRENT_RUNS", 12),
      maxConcurrentImports: 3,
      maxSessionsPerIp: 6,
      repoMaxFiles: 300,
      repoMaxBytes: 2 * 1024 * 1024,
      fileMaxBytes: 200 * 1024,
      overlayMaxBytes: 1024 * 1024,
      tarballMaxBytes: 8 * 1024 * 1024,
      tarballMaxUnpackedBytes: 24 * 1024 * 1024,
      importTimeoutMs: 15_000,
    },
  };
}
