#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rm -f commerce-plugin-external-review.zip
rm -rf .review-staging
mkdir -p .review-staging/packages/plugins

rsync -a --exclude 'node_modules' --exclude '.vite' \
  packages/plugins/commerce/ .review-staging/packages/plugins/commerce/

REVIEW_FILES=(
  "README_REVIEW.md"
  "@THIRD_PARTY_REVIEW_PACKAGE.md"
  "externa_review.md"
  "external_review.md"
  "HANDOVER.md"
  "commerce-plugin-architecture.md"
  "3rd-party-checklist.md"
)

for file in "${REVIEW_FILES[@]}"; do
  if [ -f "$file" ]; then
    mkdir -p ".review-staging/$(dirname "$file")"
    cp "$file" ".review-staging/$file"
  fi
done

find .review-staging -type f -name '*.zip' -delete

(cd .review-staging && zip -rq ../commerce-plugin-external-review.zip .)
rm -rf .review-staging

echo "Wrote $ROOT/commerce-plugin-external-review.zip"
