# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# ── Pre-fetch all registry packages using only the lockfile ──────────────────
# This layer is cached as long as pnpm-lock.yaml doesn't change.
COPY pnpm-lock.yaml .npmrc ./
RUN pnpm fetch

# ── Copy full source tree ─────────────────────────────────────────────────────
# pnpm workspace needs every member's package.json present to resolve the graph.
COPY . .

# ── Install from the pre-fetched store (no network required) ─────────────────
RUN pnpm install --frozen-lockfile --offline

# ── Build only the packages that have a build script and are used by the template
# emdash (core) and @emdash-cms/admin are the only compiled workspace deps.
# @emdash-cms/plugin-audit-log exports raw TypeScript (no build step needed).
RUN pnpm --filter emdash --filter @emdash-cms/admin --filter @emdash-cms/auth --filter @emdash-cms/blocks build

# ── Build the blog template (Astro SSR → dist/) ──────────────────────────────
RUN pnpm --filter @emdash-cms/template-blog build


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# better-sqlite3 is a pre-compiled native module from the builder (same arch/OS).
# No build tools needed at runtime.
WORKDIR /app

# ── Copy the pnpm virtual store ───────────────────────────────────────────────
# Hard links in .pnpm become file copies across Docker stages — that's fine.
# Relative symlinks (node_modules/pkg → .pnpm/…) are preserved by COPY.
COPY --from=builder /app/node_modules             ./node_modules

# ── Workspace root manifests ──────────────────────────────────────────────────
COPY --from=builder /app/package.json             ./
COPY --from=builder /app/pnpm-workspace.yaml      ./

# ── Workspace packages (symlink targets in node_modules) ─────────────────────
# Only packages that the blog template references at runtime are needed.

# emdash (core) — compiled
COPY --from=builder /app/packages/core/package.json   packages/core/
COPY --from=builder /app/packages/core/dist/           packages/core/dist/

# @emdash-cms/admin — compiled
COPY --from=builder /app/packages/admin/package.json  packages/admin/
COPY --from=builder /app/packages/admin/dist/          packages/admin/dist/

# @emdash-cms/auth — compiled
COPY --from=builder /app/packages/auth/package.json   packages/auth/
COPY --from=builder /app/packages/auth/dist/           packages/auth/dist/

# @emdash-cms/blocks — compiled
COPY --from=builder /app/packages/blocks/package.json packages/blocks/
COPY --from=builder /app/packages/blocks/dist/         packages/blocks/dist/

# @emdash-cms/plugin-audit-log — exports raw TS src, no dist needed
COPY --from=builder /app/packages/plugins/audit-log/package.json packages/plugins/audit-log/
COPY --from=builder /app/packages/plugins/audit-log/src/          packages/plugins/audit-log/src/

# ── The compiled Astro blog application ──────────────────────────────────────
COPY --from=builder /app/templates/blog/dist/          templates/blog/dist/
COPY --from=builder /app/templates/blog/package.json   templates/blog/
COPY --from=builder /app/templates/blog/astro.config.mjs templates/blog/

# ── Persistent data volumes ───────────────────────────────────────────────────
# /app/templates/blog/data    → SQLite database file (mount as Coolify volume)
# /app/templates/blog/uploads → user-uploaded media  (mount as Coolify volume)
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
