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
# Just used as a source for /usr/local/{bin,include,lib,share}/node*.
# We install pnpm into this stage so we can copy it across too, avoiding any
# TLS-dependent npm install in the final sandbox image.
RUN npm install -g pnpm@11.1.3 \
    && pnpm --version

FROM cloudflare/sandbox:0.12.1

# Base packages the agent's shell needs. Kept minimal -- xz-utils etc. are
# unnecessary now that we don't download Node ourselves.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy Node, npm, AND pnpm from the official Node image. This brings the
# binaries plus the corresponding node_modules tree they require to run.
# Doing the install in the source stage avoids any TLS-dependent network call
# in the final image, where the sandbox base's CA bundle is unreliable.
COPY --from=node-source /usr/local/bin/node /usr/local/bin/node
COPY --from=node-source /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-source /usr/local/include/node /usr/local/include/node

# The slim image's /usr/local/bin/{npm,npx,pnpm,pnpx} are symlinks into
# /usr/local/lib/node_modules; Docker COPY of symlinks copies the target file,
# losing the symlink relationship. Recreate the symlinks so the CLIs work.
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -sf /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
    && ln -sf /usr/local/lib/node_modules/pnpm/bin/pnpx.cjs /usr/local/bin/pnpx \
    && chmod +x /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs \
                /usr/local/lib/node_modules/pnpm/bin/pnpx.cjs \
                /usr/local/lib/node_modules/npm/bin/npm-cli.js \
                /usr/local/lib/node_modules/npm/bin/npx-cli.js \
    && node --version && npm --version && pnpm --version

# The agent operates under /workspace; the workflow clones into /workspace/repo.
WORKDIR /workspace
