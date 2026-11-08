# syntax=docker/dockerfile:1
# CodeFang web playground: one service serves the API and the built frontend.

# ---- deps: full install (dev deps needed to build the frontend) -------------
FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- build: bundle the React frontend into web-demo/dist ---------------------
FROM deps AS build
COPY . .
RUN bun run web:build

# ---- prod-deps: runtime dependencies only ------------------------------------
FROM oven/bun:1.4.2 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime -----------------------------------------------------------------
FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8788

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
# The agent core the playground reuses (tools, overlay, planner).
COPY ai ./ai
COPY modes ./modes
COPY tui ./tui
COPY web-demo/server ./web-demo/server
COPY web-demo/samples ./web-demo/samples
COPY --from=build /app/web-demo/dist ./web-demo/dist

USER bun
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8788) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "web-demo/server/main.ts"]
