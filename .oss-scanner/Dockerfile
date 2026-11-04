# Node.js 22 matches the main CI test jobs.
FROM node:22-bookworm

ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    ASTRO_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=4096

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

# The scanner expects the complete checkout, including test fixtures, at /src.
COPY . /src
WORKDIR /src

# Corepack reads the pnpm version from packageManager in package.json.
RUN corepack enable && corepack prepare --activate
RUN pnpm install --frozen-lockfile

# Browser tests must not need downloads after the scanner disables networking.
RUN pnpm exec playwright install --with-deps chromium
RUN pnpm build

# Exercise the security-relevant suites while online so any lazily fetched
# runtime pieces (workerd, Chromium) are cached in the image.
RUN pnpm --filter @emdash-cms/auth exec vitest run
RUN pnpm --filter emdash exec vitest run \
    tests/unit/auth \
    tests/unit/middleware \
    tests/unit/api/csrf.test.ts \
    tests/unit/api/content-route-permissions.test.ts \
    tests/unit/api/media-file-private-keys.test.ts \
    tests/unit/plugins \
    tests/unit/utils/sanitize.test.ts
RUN pnpm --filter @emdash-cms/sandbox-workerd exec vitest run \
    test/backing-service-authorization.test.ts \
    test/bridge-handler.test.ts \
    test/miniflare-isolation.test.ts \
    test/plugin-integration.test.ts \
    test/runner-env-isolation.test.ts \
    test/wrapper-context.test.ts \
    test/wrapper-storage.test.ts
RUN pnpm --filter @emdash-cms/admin exec vitest run tests/editor/link-destination-input.test.tsx
