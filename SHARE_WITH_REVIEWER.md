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
- full `packages/plugins/commerce/` source tree (excluding build artifacts),
- all `*.md` files in the repository except files excluded by `node_modules`/`.git`,
- without any nested `*.zip` artifacts.

For local verification, confirm the archive metadata in your message:
- File path: `./commerce-plugin-external-review.zip`
- Generator script: `scripts/build-commerce-external-review-zip.sh`

