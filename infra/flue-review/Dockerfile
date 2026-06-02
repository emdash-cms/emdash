# Pinned to match the @cloudflare/sandbox version in package.json (0.10.3);
# the image and the SDK are versioned together. The base bundles the
# control-plane server, `node`, `git`, and `curl`, with a working dir at
# /workspace. The reviewer is git-only (no `gh`): it clones the public repo
# over https and diffs locally, so no extra tooling is required here.
FROM docker.io/cloudflare/sandbox:0.10.3
