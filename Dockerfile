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
# vite-config.ts resolveAdminSource() checks for packages/admin/src/ and if
# found aliases Vite to raw TS instead of dist/ → build failure.
# core/src/ MUST remain: routes/* and ui exports point directly to src/.
RUN rm -rf packages/admin/src

# ── Build the blog template (Astro SSR → dist/) ──────────────────────────────
RUN pnpm --filter @emdash-cms/template-rgb-animation build

# ── Create a self-contained production deployment directory ──────────────────
# pnpm deploy resolves all workspace:* links, installs only prod deps,
# and produces a flat node_modules with NO symlinks — safe to copy between
# Docker stages. The blog dist/ is included because templates/blog has no
# "files" field so pnpm deploy copies everything.
RUN pnpm deploy --filter @emdash-cms/template-rgb-animation --prod --legacy /deploy


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# better-sqlite3 native bindings require libstdc++ at runtime.
# The builder stage has it implicitly via g++, but this clean image does not.
RUN apk add --no-cache libstdc++ libc6-compat

WORKDIR /app

# ── Copy the fully resolved, symlink-free deployment directory ────────────────
COPY --from=builder /deploy .

# ── Copy the compiled dist/ (excluded by .gitignore, so pnpm deploy skips it) -
COPY --from=builder /app/templates/rgb-animation/dist/ ./dist/

# ── Persistent data volumes ───────────────────────────────────────────────────
RUN mkdir -p data uploads

VOLUME ["/app/data", "/app/uploads"]

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV EMDASH_AUTH_SECRET=""
ENV EMDASH_PREVIEW_SECRET=""

EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('net').createConnection(4321,'localhost').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

CMD ["node", "./dist/server/entry.mjs"]
