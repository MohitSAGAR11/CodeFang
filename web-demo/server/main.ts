import type { HTMLBundle, Server } from "bun";
import { createModel } from "../../ai/ai.config.ts";
import fs from "node:fs";
import path from "node:path";
import { createApi, type ModelFactory } from "./api.ts";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { loadSamples } from "./samples.ts";

const SWEEP_MS = 60_000;

/** Per-response security headers. CSP only in production (dev HMR needs inline/ws). */
function securityHeaders(production: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
  if (production) {
    headers["content-security-policy"] = [
      "default-src 'self'",
      "script-src 'self'",
      // Inline style attributes only (tree indentation, diagram chip position).
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; ");
    headers["strict-transport-security"] = "max-age=31536000";
  }
  return headers;
}

/**
 * Behind a proxy (Railway), the client IP is the Nth entry from the right of
 * X-Forwarded-For, where N = TRUST_PROXY_HOPS. Entries further left are
 * client-controlled and ignored. With hops = 0 the socket address is used.
 */
export function clientIp(req: Request, socketIp: string | undefined, hops: number): string {
  if (hops > 0) {
    const chain = (req.headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const pick = chain[chain.length - hops];
    if (pick) return pick;
  }
  return socketIp ?? "unknown";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve a directory of prebuilt files. The file list is read once at startup
 * and requests are matched by exact path string, so nothing outside it
 * (and no `..` trick) can ever be served.
 */
function staticHandler(dir: string) {
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) files.set(path.relative(dir, full).split(path.sep).join("/"), full);
    }
  };
  walk(dir);
  return (pathname: string): Response | undefined => {
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    const full = files.get(name);
    if (!full) return undefined;
    const ext = path.extname(name);
    const hashed = /-[a-z0-9]{6,}\.(js|css)$/i.test(name);
    return new Response(Bun.file(full), {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": hashed
          ? "public, max-age=31536000, immutable"
          : name.startsWith("fonts/")
            ? "public, max-age=604800"
            : "no-cache",
      },
    });
  };
}

export async function startServer(opts: { modelFactory?: ModelFactory; port?: number } = {}) {
  const config = loadConfig();
  const samples = loadSamples(config.samplesDir, config.limits);
  const modelFactory: ModelFactory =
    opts.modelFactory ?? (({ apiKey, modelId }) => createModel({ apiKey, modelId }));
  const api = createApi({ config, samples, modelFactory });
  const headers = securityHeaders(config.production);

  const withHeaders = (res: Response): Response => {
    for (const [k, v] of Object.entries(headers)) if (!res.headers.has(k)) res.headers.set(k, v);
    return res;
  };

  const staticDir = path.resolve(process.env.DEMO_STATIC_DIR ?? path.join(process.cwd(), "web-demo", "dist"));
  const useStatic = config.production && fs.existsSync(path.join(staticDir, "index.html"));
  if (config.production && !useStatic) {
    throw new Error(`No built frontend at ${staticDir}. Run \`bun run web:build\` first.`);
  }
  // Production: the built bundle. Dev: just the public assets (fonts); Bun bundles the rest.
  const publicDir = path.join(process.cwd(), "web-demo", "app", "public");
  const serveStatic = useStatic
    ? staticHandler(staticDir)
    : fs.existsSync(publicDir)
      ? staticHandler(publicDir)
      : undefined;
  // Dev only: Bun bundles the HTML on the fly, with HMR.
  const devRoutes: Record<string, HTMLBundle> = useStatic
    ? {}
    : { "/": (await import("../app/index.html")).default };

  const server = Bun.serve({
    port: opts.port ?? config.port,
    hostname: "0.0.0.0",
    development: !config.production,
    // SSE runs stream for minutes; heartbeats keep the socket busy well inside this.
    idleTimeout: 120,
    maxRequestBodySize: 64 * 1024,
    routes: {
      ...devRoutes,
      "/healthz": () => withHeaders(new Response("ok")),
    },
    async fetch(req: Request, srv: Server<undefined>) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) {
        const ip = clientIp(req, srv.requestIP(req)?.address, config.trustProxyHops);
        return withHeaders(await api.handle(req, ip));
      }
      const asset = req.method === "GET" || req.method === "HEAD" ? serveStatic?.(url.pathname) : undefined;
      if (asset) return withHeaders(asset);
      return withHeaders(new Response("Not found", { status: 404 }));
    },
  });

  const sweeper = setInterval(() => api.store.sweep(), SWEEP_MS);
  sweeper.unref?.();

  log("server.start", {
    port: server.port,
    samples: samples.size,
    serverKey: !!config.serverKey,
    production: config.production,
    githubImport: config.githubImport,
    webTools: config.webTools,
  });
  return server;
}

if (import.meta.main) await startServer();
