# External developer review — pointer

The full briefing for reviewers is in **[`@THIRD_PARTY_REVIEW_PACKAGE.md`](./@THIRD_PARTY_REVIEW_PACKAGE.md)**, then `HANDOVER.md`, `commerce-plugin-architecture.md`, and `3rd-party-checklist.md`.

Use `@THIRD_PARTY_REVIEW_PACKAGE.md` as the canonical entrypoint.

Regenerating **`commerce-plugin-external-review.zip`** copies the canonical review
packets plus the commerce plugin sources. Zip files are not included in the bundle.

Priority review areas:
- same-event concurrent webhook delivery remains the primary residual production risk,
- receipt `pending` semantics must remain replay-safe and resumable,
- concentrate on duplicate delivery, partial writes, and ownership/possession boundaries before suggesting broader architecture changes.
