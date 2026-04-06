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
  "@THIRD_PARTY_REVIEW_PACKAGE.md"
  "external_review.md"
  "SHARE_WITH_REVIEWER.md"
  "HANDOVER.md"
  "commerce-plugin-architecture.md"
  "3rd-party-checklist.md"
  "emdash-commerce-third-party-review-memo.md"
  "emdash_commerce_review_update_ordered_children.md"
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
