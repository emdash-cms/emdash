# Files to share with a 3rd-party reviewer

Use `@THIRD_PARTY_REVIEW_PACKAGE.md` as the single canonical review entrypoint.

For a single-file handoff, share:

- `commerce-plugin-external-review.zip`
- `SHARE_WITH_REVIEWER.md` (this file)

`commerce-plugin-external-review.zip` is regenerated from the current repository
state via:

```bash
./scripts/build-commerce-external-review-zip.sh
```

That archive contains:

- full `packages/plugins/commerce/` source tree (excluding `node_modules` and `.vite`),
- all review packet files required for onboarding:
  - `@THIRD_PARTY_REVIEW_PACKAGE.md`
  - `external_review.md`
  - `HANDOVER.md`
  - `commerce-plugin-architecture.md`
  - `3rd-party-checklist.md`
- no nested `*.zip` artifacts.

For local verification, confirm the archive metadata in your message:

- File path: `./commerce-plugin-external-review.zip`
- Generator script: `scripts/build-commerce-external-review-zip.sh`
- Build anchor: commit `bda8b75` (generated 2026-04-03)

`SHARE_WITH_REVIEWER.md` is intentionally shared outside the zip because it is the
single-file handoff companion and should be included directly in the reviewer message.

Ask reviewers to focus on:

- same-event concurrent webhook delivery as the main residual production risk,
- `pending` receipt semantics as a replay/resume correctness boundary,
- duplicate delivery, partial-write recovery, and cart ownership edge cases over broad architecture suggestions.
