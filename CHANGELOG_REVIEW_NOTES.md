# Third-Party Review Changelog Notes

- 2026-04-03: Added canonicalized review-entrypath alignment (single canonical packet via `@THIRD_PARTY_REVIEW_PACKAGE.md`), removed lingering legacy `src/hash.ts` dependence from review status, and recorded stage-1 runtime completion: possession enforcement + closed-loop finalize path + deterministic webhook/idempotency behavior.
- 2026-04-02: Replaced partial commerce error metadata in `packages/plugins/commerce/src/kernel/errors.ts` with canonical `COMMERCE_ERRORS` to align kernel error contracts with architecture.
- 2026-04-02: Clarified `packages/plugins/commerce/src/kernel/limits.ts` and related comments to state explicit fixed-window rate-limit semantics, matching implementation behavior.
- 2026-04-02: Added fixed-window boundary coverage in `packages/plugins/commerce/src/kernel/rate-limit-window.test.ts` to prevent ambiguity around window resets.
- 2026-04-02: Expanded finalize decision types and precedence rules in `packages/plugins/commerce/src/kernel/finalize-decision.ts` to handle paid/replay/pending/error/non-finalizable states deterministically.
- 2026-04-02: Updated `packages/plugins/commerce/src/kernel/finalize-decision.test.ts` with coverage for webhook receipt states (`processed`, `duplicate`, `pending`, `error`) and explicit already-paid/no-op precedence.
