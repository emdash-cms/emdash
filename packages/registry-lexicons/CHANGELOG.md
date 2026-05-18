# @emdash-cms/registry-lexicons

## 0.1.0

### Minor Changes

- [#929](https://github.com/emdash-cms/emdash/pull/929) [`5464b55`](https://github.com/emdash-cms/emdash/commit/5464b551f0100d33fe9adbdd74d3444d37321209) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `RECORD_NSIDS` and `QUERY_NSIDS` const arrays alongside the existing `NSID` map. They enumerate the record-shaped and query-shaped lexicons in this package so consumers (e.g. tooling that builds OAuth `repo:` / `rpc:` scopes) can derive their list from the lexicon set instead of hand-rolling one that drifts.

### Patch Changes

- [#923](https://github.com/emdash-cms/emdash/pull/923) [`943df46`](https://github.com/emdash-cms/emdash/commit/943df46d62043df386eef4664fbba4710be16c31) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `@emdash-cms/registry-lexicons`: generated TypeScript types and runtime validation schemas for the EmDash plugin registry lexicons (`com.emdashcms.experimental.*`). EXPERIMENTAL — NSIDs and shapes will change while RFC 0001 is in flight; pin to an exact version.
