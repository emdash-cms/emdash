#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -f commerce-plugin-external-review.zip
rm -rf .review-staging
mkdir -p .review-staging/packages/plugins

rsync -a --exclude 'node_modules' --exclude '.vite' \
  packages/plugins/commerce/ .review-staging/packages/plugins/commerce/

find . -type f -name '*.md' \
  ! -path './node_modules/*' \
  ! -path '*/node_modules/*' \
  ! -path './.git/*' \
  ! -path './.review-staging/*' \
  -print0 | while IFS= read -r -d '' f; do
    rel="${f#./}"
    dest=".review-staging/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  done

find .review-staging -type f -name '*.zip' -delete

(cd .review-staging && zip -rq ../commerce-plugin-external-review.zip .)
rm -rf .review-staging

echo "Wrote $ROOT/commerce-plugin-external-review.zip"
