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
RUN pnpm --filter emdash --filter @emdash-cms/admin --filter @emdash-cms/auth --filter @emdash-cms/blocks build

# ── Remove workspace src/ so Vite uses compiled dist/ only ───────────────────
# vite-config.ts resolveAdminSource() checks if packages/admin/src/ exists.
# If it does, Vite tries to compile raw TS from the workspace symlink → fails.
RUN rm -rf packages/admin/src packages/auth/src packages/blocks/src packages/core/src

# ── Build the blog template — print full output on failure ───────────────────
RUN pnpm --filter @emdash-cms/template-blog build 2>&1 | tee /tmp/astro-build.log; \
    BUILD_EXIT=${PIPESTATUS[0]}; \
    if [ "$BUILD_EXIT" != "0" ]; then \
      echo ""; \
      echo "========== ASTRO BUILD FAILED — FULL LOG =========="; \
      cat /tmp/astro-build.log; \
      echo "===================================================="; \
      exit 1; \
    fi


# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

COPY --from=builder /app/node_modules             ./node_modules
COPY --from=builder /app/package.json             ./
COPY --from=builder /app/pnpm-workspace.yaml      ./

COPY --from=builder /app/packages/core/package.json   packages/core/
COPY --from=builder /app/packages/core/dist/           packages/core/dist/
COPY --from=builder /app/packages/admin/package.json  packages/admin/
COPY --from=builder /app/packages/admin/dist/          packages/admin/dist/
COPY --from=builder /app/packages/auth/package.json   packages/auth/
COPY --from=builder /app/packages/auth/dist/           packages/auth/dist/
COPY --from=builder /app/packages/blocks/package.json packages/blocks/
COPY --from=builder /app/packages/blocks/dist/         packages/blocks/dist/
COPY --from=builder /app/packages/plugins/audit-log/package.json packages/plugins/audit-log/
COPY --from=builder /app/packages/plugins/audit-log/src/          packages/plugins/audit-log/src/

COPY --from=builder /app/templates/blog/dist/          templates/blog/dist/
COPY --from=builder /app/templates/blog/package.json   templates/blog/
COPY --from=builder /app/templates/blog/astro.config.mjs templates/blog/

RUN mkdir -p templates/blog/data templates/blog/uploads

VOLUME ["/app/templates/blog/data", "/app/templates/blog/uploads"]

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV EMDASH_AUTH_SECRET=""
ENV EMDASH_PREVIEW_SECRET=""

EXPOSE 4321

WORKDIR /app/templates/blog

CMD ["node", "./dist/server/entry.mjs"]
