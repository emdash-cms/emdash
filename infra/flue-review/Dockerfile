# Pinned to match the @cloudflare/sandbox version in package.json (0.12.1);
# the image and the SDK are versioned together. The base bundles the
# control-plane server, `node`, `git`, and `curl`, with a working dir at
# /workspace. The reviewer is git-only (no `gh`): it clones the public repo
# over https and diffs locally.
FROM docker.io/cloudflare/sandbox:0.12.1

# ripgrep: the review agent reaches for `rg` to search the checkout. Without it,
# `rg` exits 127, which kills the sandbox shell session ("cannot execute further
# commands") and aborts the rest of the review. Install it so searches work.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ripgrep \
	&& rm -rf /var/lib/apt/lists/*
