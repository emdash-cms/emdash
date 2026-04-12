#!/bin/sh
# Relink workspace bin symlinks after build, but only when needed.
# pnpm only creates bin links when the target file exists at install time.
# Since the CLI lives in dist/, it doesn't exist until after the first build.

# Skip in CI — bins are handled by the CI setup step
[ -n "$CI" ] && exit 0

CLI_BIN="$(pnpm bin)/emdash"
CLI_SRC="packages/core/dist/cli/index.mjs"

if [ ! -x "$CLI_BIN" ] || [ ! -f "$CLI_SRC" ]; then
	echo "CLI bin missing — relinking..."
	pnpm install --frozen-lockfile
elif [ "$CLI_SRC" -nt "$CLI_BIN" ]; then
	echo "CLI bin stale — relinking..."
	pnpm install --frozen-lockfile
fi
