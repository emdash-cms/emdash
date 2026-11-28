---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Makes `emdash media repair-usage` stop safely before exhausting D1's per-request query allowance on Workers Paid, leaving queries available to release write leases and save status. Repair returns `CONTENT_USAGE_QUERY_LIMIT` and preserves its indexed-source count instead of returning a generic failure. This does not enable large collections to finish: resumable batches are not yet supported, and repeated runs restart at the first entry. Use `--json` and check the returned status rather than treating exit code `0` as complete coverage. The lower query allowance on Workers Free is not covered by this safeguard.
