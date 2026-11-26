# @emdash-cms/registry-moderation

## 0.3.0

### Minor Changes

- [#4914](https://github.com/emdash-cms/emdash/pull/4914) [`e7c8f19`](https://github.com/emdash-cms/emdash/commit/e7c8f19f560b5cb79a781f71cca6372d3acee317) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds finding categories and an optional severity for assessments of a release's package code, so labelers can report code findings in the same shape as listing findings.
  
  `@emdash-cms/registry-moderation` exports `CODE_FINDING_CATEGORIES` (`malicious-code`, `vulnerability`, `reviewer-manipulation`, `package-integrity`, and `review-declined` for a reviewer model that refused to review the code), `FINDING_SEVERITIES`, and `AssessmentFindingSchema`, which accepts both listing and code findings. `ModerationCoverage` gains an optional `code` field. `NormalizedModerationFindingSchema` still accepts listing categories only, so existing model-output validation is unchanged.
  
  `@emdash-cms/registry-verification/bundle` now exports the bundle size and entry limits (`MAX_BUNDLE_COMPRESSED_BYTES`, `MAX_BUNDLE_DECOMPRESSED_BYTES`, `MAX_BUNDLE_FILE_BYTES`, `MAX_BUNDLE_FILE_COUNT`, `MAX_BUNDLE_SIZE`, `MAX_BUNDLE_TAR_ENTRY_COUNT`), so Workers code can apply the same limits without importing the Node entry point.

## 0.2.0

### Minor Changes

- [#2742](https://github.com/emdash-cms/emdash/pull/2742) [`4cc150e`](https://github.com/emdash-cms/emdash/commit/4cc150e931313644a96b796627e5ec74b46c0aec) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `moderation-manipulation` findings so labelers can distinguish direct attempts to bypass automated moderation from quoted or descriptive discussion of prompt injection.

## 0.1.0

### Minor Changes

- [#2644](https://github.com/emdash-cms/emdash/pull/2644) [`6178888`](https://github.com/emdash-cms/emdash/commit/61788888bf5933e2a9ac310a931f1c241fa63878) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds shared, CID-bound plugin-listing moderation contracts for reducing signed AT Protocol labels and deciding which package-profile and release revisions are eligible for display.

  The registry Lexicons add experimental public assessment and policy queries. The contracts cover publisher-controlled listing metadata and displayed media; they do not assess plugin code.
