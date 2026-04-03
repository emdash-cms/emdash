# Third-Party Review Package

Use this as the single canonical starting point for external review.

## Share these files

1. `@THIRD_PARTY_REVIEW_PACKAGE.md` — canonical entrypoint
2. `externa_review.md` — full system/repo context
3. `HANDOVER.md` — current implementation status
4. `commerce-plugin-architecture.md` — architecture and invariants
5. `3rd-party-checklist.md` — pass/fail checklist

## Supporting evidence

- `packages/plugins/commerce/FINALIZATION_REVIEW_AUDIT.md`
- `packages/plugins/commerce/COMMERCE_DOCS_INDEX.md`
- `packages/plugins/commerce/src/orchestration/finalize-payment.ts`
- `packages/plugins/commerce/src/orchestration/finalize-payment.test.ts`

## Reviewer guidance

- Treat `@THIRD_PARTY_REVIEW_PACKAGE.md` as the only current entrypoint.
- Treat older `review`/`plan`/`instructions` files at the repo root as historical context unless this file links to them explicitly.
- The main residual production caveat is the documented same-event concurrency limit of the underlying storage model.

