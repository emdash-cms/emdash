# @emdash-cms/auth

## 0.4.0

## 0.3.0

## 0.2.0

### Patch Changes

- [#452](https://github.com/emdash-cms/emdash/pull/452) [`1a93d51`](https://github.com/emdash-cms/emdash/commit/1a93d51777afaec239641e7587d6e32d8a590656) Thanks [@kamine81](https://github.com/kamine81)! - Fixes GitHub OAuth login failing with 403 on accounts where email is private. GitHub's API requires a `User-Agent` header and rejects requests without it.

## 0.1.1

### Patch Changes

- [#133](https://github.com/emdash-cms/emdash/pull/133) [`9269759`](https://github.com/emdash-cms/emdash/commit/9269759674bf254863f37d4cf1687fae56082063) Thanks [@kyjus25](https://github.com/kyjus25)! - Fix auth links and OAuth callbacks to use `/_emdash/api/auth/...` so emailed sign-in, signup, and invite URLs resolve correctly in EmDash.

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
