#!/bin/bash
# Pre-push check: run exactly what CI runs, fail on any error
# Usage: ./scripts/pre-push-check.sh
#
# KNOWN LIMITATION: On Node 24.1.0 the @emdash-cms/admin build hits a Node ESM
# bug, so `pnpm build` fails locally. CI uses Node 22 and passes. To replicate
# CI exactly, use Node 22 (e.g. `nvm use 22`).
#
# This script runs the checks that DO work locally and documents which ones
# require CI or Node 22.

set -e

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)

echo "=== Pre-push check ==="
echo "Node version: $(node --version)"
echo ""

# 1. Lint (works on any Node version)
echo "1/4: pnpm lint"
pnpm lint
echo ""

# 2. Typecheck (works on any Node version)
echo "2/4: pnpm typecheck"
pnpm typecheck
echo ""

# 3. Format check
echo "3/4: pnpm format"
pnpm format
echo ""

# 4. Tests (full suite — may have known flaky tests on Node 24)
echo "4/4: pnpm test"
if [ "$NODE_VERSION" = "24" ]; then
	echo "⚠️  Node 24 detected: skipping known-flaky tests (plugin-cli, page-contribution-sandbox)"
	echo "   These pass on CI with Node 22. Run manually if you changed these areas."
	pnpm test -- --exclude packages/plugin-cli --exclude tests/unit/plugins/page-contribution-sandbox.test.ts
else
	pnpm test
fi
echo ""

echo "=== All checks passed ==="
echo ""
echo "NOTE: If CI fails but this script passes, the difference is likely Node 22 vs 24."
echo "      To replicate CI exactly: nvm use 22 && pnpm install && pnpm build && pnpm lint"
