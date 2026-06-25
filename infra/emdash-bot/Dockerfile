# Container image for the emdash-bot investigate agent's sandbox.
#
# Phase 0 (this spike): minimal. Just Node + pnpm + git so the agent can clone
# the repo and run JS-shaped commands. No browser yet — browser support is
# Phase 2 once we know the simpler agent path works end-to-end.
#
# Image tag matches the @cloudflare/sandbox package version we depend on.
FROM cloudflare/sandbox:0.12.1

# Toolchain the agent's shell needs. `gh` is included so the agent can read
# (only) — the agent's GH token is read-only by design; writes happen
# OUTSIDE the container from the trusted Orchestrator DO.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# pnpm via Corepack (already in the base image's Node).
RUN corepack enable && corepack prepare pnpm@11.1.3 --activate

# The agent operates under /workspace; the workflow clones into /workspace/repo.
WORKDIR /workspace
