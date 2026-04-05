# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Required for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# ── Pre-fetch all registry packages using only the lockfile ──────────────────
COPY pnpm-lock.yaml .npmrc ./
RUN pnpm fetch

# ── Copy full workspace source ────────────────────────────────────────────────
COPY . .

# ── Install from the pre-fetched store ───────────────────────────────────────
RUN pnpm install --frozen-lockfile --offline

# ── Build library packages ────────────────────────────────────────────────────
RUN pnpm --filter emdash \
         --filter @emdash-cms/admin \
         --filter @emdash-cms/auth \
         --filter @emdash-cms/blocks \
         --filter @emdash-cms/gutenberg-to-portable-text \
         build

# ── Remove admin/src/ so Vite uses compiled dist/ only ───────────────────────
RUN rm -rf packages/admin/src

# ── Build the template (Astro SSR → dist/) ────────────────────────────────────
RUN pnpm --filter @emdash-cms/template-rgb-animation build

# ── Create a self-contained production deployment directory ──────────────────
RUN pnpm deploy --filter @emdash-cms/template-rgb-animation --prod --legacy /deploy

# ── Ensure Vite-externalized modules are resolvable at runtime ────────────────
# Vite SSR marks better-sqlite3 as external (native addon) and the sqlite
# dialect shim uses CJS require("kysely") at runtime. pnpm deploy resolves
# workspace deps but these externalized packages may not end up as top-level
# entries in /deploy/node_modules/. Copy them from the fully resolved
# workspace node_modules (which has everything properly installed).
RUN for pkg in kysely better-sqlite3 bindings file-uri-to-path; do \
      if [ ! -d "/deploy/node_modules/$pkg" ]; then \
        if [ -e "/app/node_modules/$pkg" ]; then \
          cp -rL "/app/node_modules/$pkg" "/deploy/node_modules/$pkg"; \
          echo "Copied $pkg to deploy"; \
        else \
          echo "WARN: $pkg not found in workspace node_modules"; \
        fi; \
      else \
        echo "OK: $pkg already in deploy"; \
      fi; \
    done


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# better-sqlite3 native bindings require libstdc++ at runtime.
RUN apk add --no-cache libstdc++ libc6-compat

WORKDIR /app

# ── Copy the fully resolved, symlink-free deployment directory ────────────────
COPY --from=builder /deploy .

# ── Copy the compiled dist/ (excluded by .gitignore, so pnpm deploy skips it) -
COPY --from=builder /app/templates/rgb-animation/dist/ ./dist/

# ── Persistent data volumes ───────────────────────────────────────────────────
RUN mkdir -p data uploads

# ── Startup diagnostics script ────────────────────────────────────────────────
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

VOLUME ["/app/data", "/app/uploads"]

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV EMDASH_AUTH_SECRET=""
ENV EMDASH_PREVIEW_SECRET=""

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('net').createConnection(4321,'localhost').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

CMD ["/app/docker-entrypoint.sh"]
