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
# All package.json files must be present for pnpm workspace resolution.
COPY . .

# ── Install from the pre-fetched store ───────────────────────────────────────
RUN pnpm install --frozen-lockfile --offline

# ── Build library packages (only those with a build script) ──────────────────
RUN pnpm --filter emdash --filter @emdash-cms/admin --filter @emdash-cms/auth --filter @emdash-cms/blocks build

# ── Remove package src/ directories before Astro build ───────────────────────
# vite-config.ts calls resolveAdminSource() which checks if packages/admin/src/
# exists. If it does, Vite tries to compile raw TypeScript from the symlinked
# workspace package instead of using dist/ — causing the build to fail.
# Removing src/ forces the build to use the pre-compiled dist/ output.
RUN rm -rf packages/admin/src packages/auth/src packages/blocks/src packages/core/src

# ── Build the blog template (Astro SSR → dist/) ──────────────────────────────
RUN pnpm --filter @emdash-cms/template-blog build


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# ── Copy the pnpm virtual store ───────────────────────────────────────────────
# Hard links in .pnpm become file copies across Docker stages — that's fine.
# Relative symlinks in node_modules/ are preserved by COPY.
COPY --from=builder /app/node_modules             ./node_modules

# ── Workspace root manifests ──────────────────────────────────────────────────
COPY --from=builder /app/package.json             ./
COPY --from=builder /app/pnpm-workspace.yaml      ./

# ── Workspace packages (pnpm symlink targets) ────────────────────────────────

# emdash (core) — compiled to dist/
COPY --from=builder /app/packages/core/package.json   packages/core/
COPY --from=builder /app/packages/core/dist/           packages/core/dist/

# @emdash-cms/admin — compiled to dist/
COPY --from=builder /app/packages/admin/package.json  packages/admin/
COPY --from=builder /app/packages/admin/dist/          packages/admin/dist/

# @emdash-cms/auth — compiled to dist/
COPY --from=builder /app/packages/auth/package.json   packages/auth/
COPY --from=builder /app/packages/auth/dist/           packages/auth/dist/

# @emdash-cms/blocks — compiled to dist/
COPY --from=builder /app/packages/blocks/package.json packages/blocks/
COPY --from=builder /app/packages/blocks/dist/         packages/blocks/dist/

# @emdash-cms/plugin-audit-log — exports raw TS src (no build step)
COPY --from=builder /app/packages/plugins/audit-log/package.json packages/plugins/audit-log/
COPY --from=builder /app/packages/plugins/audit-log/src/          packages/plugins/audit-log/src/

# ── Compiled Astro blog application ──────────────────────────────────────────
COPY --from=builder /app/templates/blog/dist/          templates/blog/dist/
COPY --from=builder /app/templates/blog/package.json   templates/blog/
COPY --from=builder /app/templates/blog/astro.config.mjs templates/blog/

# ── Persistent data volumes ───────────────────────────────────────────────────
RUN mkdir -p templates/blog/data templates/blog/uploads

VOLUME ["/app/templates/blog/data", "/app/templates/blog/uploads"]

# ── Runtime environment ───────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV EMDASH_AUTH_SECRET=""
ENV EMDASH_PREVIEW_SECRET=""

EXPOSE 4321

WORKDIR /app/templates/blog

CMD ["node", "./dist/server/entry.mjs"]
