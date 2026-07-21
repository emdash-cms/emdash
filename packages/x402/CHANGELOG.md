# @emdash-cms/x402

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.1

## 0.25.0

## 0.24.1

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

### Patch Changes

- [#1530](https://github.com/emdash-cms/emdash/pull/1530) [`997d7ee`](https://github.com/emdash-cms/emdash/commit/997d7eea8f39c16eef28577bb8ace0c0413fc38b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes x402-protected routes hanging and returning 524 timeouts on Cloudflare Workers when the very first request to a cold isolate was cancelled mid-initialization. The resource server is now cached only once it is fully initialized, so a cancelled initializer no longer strands later requests.

## 0.20.0

## 0.19.0

## 0.18.0

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.1

## 0.16.0

## 0.15.0

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.0

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release
