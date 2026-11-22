---
"@emdash-cms/registry-moderation": minor
"@emdash-cms/registry-verification": minor
---

Adds finding categories and an optional severity for assessments of a release's package code, so labelers can report code findings in the same shape as listing findings.

`@emdash-cms/registry-moderation` exports `CODE_FINDING_CATEGORIES` (`malicious-code`, `vulnerability`, `reviewer-manipulation`, `package-integrity`, and `review-declined` for a reviewer model that refused to review the code), `FINDING_SEVERITIES`, and `AssessmentFindingSchema`, which accepts both listing and code findings. `ModerationCoverage` gains an optional `code` field. `NormalizedModerationFindingSchema` still accepts listing categories only, so existing model-output validation is unchanged.

`@emdash-cms/registry-verification/bundle` now exports the bundle size and entry limits (`MAX_BUNDLE_COMPRESSED_BYTES`, `MAX_BUNDLE_DECOMPRESSED_BYTES`, `MAX_BUNDLE_FILE_BYTES`, `MAX_BUNDLE_FILE_COUNT`, `MAX_BUNDLE_SIZE`, `MAX_BUNDLE_TAR_ENTRY_COUNT`), so Workers code can apply the same limits without importing the Node entry point.
