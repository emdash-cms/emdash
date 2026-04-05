# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# ── Pre-fetch all packages using only the lockfile ──────────────────────────
# This layer is cached as long as pnpm-lock.yaml doesn't change.
COPY pnpm-lock.yaml .npmrc ./
RUN pnpm fetch

# ── Copy entire source tree ──────────────────────────────────────────────────
# pnpm workspace needs every package.json present to resolve the workspace graph.
COPY . .

# ── Install from the pre-fetched store (no network) ─────────────────────────
RUN pnpm install --frozen-lockfile --offline

# ── Build workspace library packages ────────────────────────────────────────
RUN pnpm --filter emdash \
         --filter @emdash-cms/admin \
         --filter @emdash-cms/auth \
         --filter @emdash-cms/blocks \
         --filter @emdash-cms/plugin-audit-log \
         --filter @emdash-cms/marketplace \
         build

# ── Build the blog template (Astro → dist/) ─────────────────────────────────
RUN pnpm --filter @emdash-cms/template-blog build


# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# better-sqlite3 is a native module; we copy the pre-compiled binary from the
# builder (same arch/OS), so no build tools are needed at runtime.
WORKDIR /app

# ── Copy the full pnpm virtual store from builder ────────────────────────────
# pnpm symlinks inside node_modules are relative, so copying the whole
# node_modules directory is enough — no reinstall needed.
COPY --from=builder /app/node_modules ./node_modules

# ── Workspace root manifests (pnpm resolution needs these) ──────────────────
COPY --from=builder /app/package.json       ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# ── Workspace package manifests + dist/ (symlink targets) ───────────────────
# pnpm links node_modules/emdash → ../../packages/core, so the dist/ must exist.
COPY --from=builder /app/packages/core/package.json          packages/core/
COPY --from=builder /app/packages/core/dist/                 packages/core/dist/

COPY --from=builder /app/packages/admin/package.json         packages/admin/
COPY --from=builder /app/packages/admin/dist/                packages/admin/dist/

COPY --from=builder /app/packages/auth/package.json          packages/auth/
COPY --from=builder /app/packages/auth/dist/                 packages/auth/dist/

COPY --from=builder /app/packages/blocks/package.json        packages/blocks/
COPY --from=builder /app/packages/blocks/dist/               packages/blocks/dist/

COPY --from=builder /app/packages/plugins/audit-log/package.json packages/plugins/audit-log/
COPY --from=builder /app/packages/plugins/audit-log/dist/    packages/plugins/audit-log/dist/

COPY --from=builder /app/packages/marketplace/package.json   packages/marketplace/
COPY --from=builder /app/packages/marketplace/dist/          packages/marketplace/dist/

# ── The compiled Astro blog app ──────────────────────────────────────────────
COPY --from=builder /app/templates/blog/dist/          templates/blog/dist/
COPY --from=builder /app/templates/blog/package.json   templates/blog/
COPY --from=builder /app/templates/blog/astro.config.mjs templates/blog/

# ── Persistent data volumes ──────────────────────────────────────────────────
RUN mkdir -p templates/blog/data templates/blog/uploads

VOLUME ["/app/templates/blog/data", "/app/templates/blog/uploads"]

# ── Runtime configuration ─────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV EMDASH_AUTH_SECRET=""
ENV EMDASH_PREVIEW_SECRET=""

EXPOSE 4321

WORKDIR /app/templates/blog

CMD ["node", "./dist/server/entry.mjs"]
