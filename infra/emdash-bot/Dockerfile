# Container image for the emdash-bot investigate agent's sandbox.
#
# Phase 0 (this spike): minimal. Node 22 + pnpm + git, so the agent can clone
# the repo and run JS commands. No browser yet — Chromium + agent-browser land
# in Phase 2 once we know the simpler agent path works end-to-end.
#
# Multi-stage build: copy Node from the official Node Slim image rather than
# downloading it inside the cloudflare/sandbox base. The sandbox base ships
# with a partially-broken CA bundle (a curl against nodejs.org fails with
# "self-signed certificate in certificate chain"), so doing any TLS download
# from inside that base is fragile. The Node image already has Node, npm,
# and corepack laid out under /usr/local; we copy that whole tree across.

FROM node:22.21.0-bookworm-slim AS node-source
# Used as a source for Node + npm + globally-installed CLIs the agent needs:
# - pnpm: package manager for repo install
# - bgproc: runs `pnpm dev` in the background so the agent can drive it
# - agent-browser: CLI the repro-admin/public skills use to drive Chromium
#
# We do all the network/install work in this stage so the final image (built
# on the Cloudflare Sandbox base, which has a flaky CA bundle) never needs to
# reach the public npm/Chromium registries. Stage copies don't traverse TLS.
RUN npm install -g pnpm@11.1.3 bgproc@0.3.0 agent-browser@0.30.1 \
    && pnpm --version \
    && bgproc --version || true \
    && agent-browser --version || true

FROM cloudflare/sandbox:0.12.1

# Base OS packages: git for the repo clone the agent does in revise mode,
# ca-certificates for HTTPS, fonts/libs Chromium needs (the agent-browser CLI
# drives a headless Chromium that agent-browser bundles via puppeteer-core).
# These are the Debian package list puppeteer recommends; trimmed to the
# essentials so the image stays smaller.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    build-essential \
    python3 \
    python-is-python3 \
    ripgrep \
    jq \
    tree \
    less \
    file \
    unzip \
    sqlite3 \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy Node + npm + the globally-installed pnpm/bgproc/agent-browser CLIs from
# the source stage. Stage copies bypass TLS entirely, so the broken CA bundle
# in the sandbox base never matters at install time.
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY --from=node-source /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-source /usr/local/include/node /usr/local/include/node

# Recreate the CLI symlinks the slim image had (Docker COPY flattens symlinks
# to file copies). Then chmod the .cjs/.js entry points so they're executable.
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && ln -sf /usr/local/lib/node_modules/pnpm/bin/pnpx.cjs /usr/local/bin/pnpx \
    && ln -sf /usr/local/lib/node_modules/bgproc/dist/cli.mjs /usr/local/bin/bgproc \
    && ln -sf /usr/local/lib/node_modules/agent-browser/bin/agent-browser.js /usr/local/bin/agent-browser \
    && find /usr/local/lib/node_modules \
       \( -name "npm-cli.js" -o -name "npx-cli.js" \
          -o -name "pnpm.cjs" -o -name "pnpx.cjs" \
          -o -name "cli.mjs" -path "*/bgproc/*" \
          -o -name "agent-browser.js" \) \
       -exec chmod +x {} \; \
    && node --version && npm --version && pnpm --version

ENV NODE_OPTIONS="--max-old-space-size=6144"

# The agent operates under /workspace; the workflow clones into /workspace/repo.
WORKDIR /workspace

# Trust the per-container ephemeral CA that Cloudflare's outbound interception
# generates at /etc/cloudflare/certs/cloudflare-containers-ca.crt. Without
# this, TLS handshakes from inside the container fail (or fall through
# the proxy entirely), so outboundByHost handlers in cloudflare.ts never
# see traffic. Required because we set `interceptHttps = true`.
#
# The CA only exists at container runtime, not at build time, so we copy it
# from the entrypoint before the sandbox process starts. NODE_EXTRA_CA_CERTS
# points node at it directly so the agent process trusts it too.
ENV NODE_EXTRA_CA_CERTS=/etc/cloudflare/certs/cloudflare-containers-ca.crt
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
