# @emdash-cms/cloudflare

## 0.10.0

### Patch Changes

- Updated dependencies [[`a2d3658`](https://github.com/emdash-cms/emdash/commit/a2d3658e510f292bf1fbe6b0a9e8e4f02ebc1e03), [`7e32092`](https://github.com/emdash-cms/emdash/commit/7e32092596149ae2886bae34c8d2f4bad86dbe2f)]:
  - emdash@0.10.0

## 0.9.0

### Minor Changes

- [#816](https://github.com/emdash-cms/emdash/pull/816) [`d4be24f`](https://github.com/emdash-cms/emdash/commit/d4be24f478a0c8d0a7bba3c299e11105bba3ed94) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Unifies plugin capability names under a single `<resource>[.<sub-resource>]:<verb>[:<qualifier>]` formula so capabilities read like RBAC permissions, separates hook-registration permissions from data-access ones for clearer audits, and replaces the overloaded `:any` qualifier with the more conspicuous `:unrestricted`. Old names are still accepted with `@deprecated` warnings; `emdash plugin bundle` and `emdash plugin validate` warn for each deprecated name and `emdash plugin publish` refuses manifests that still use them.

  The Cloudflare sandbox bridge and HTTP fetch helper now enforce canonical names (`content:read`, `content:write`, `media:read`, `media:write`, `users:read`, `network:request`, `network:request:unrestricted`). Manifests that still declare legacy names continue to work — the runner normalizes capabilities before passing them into the bridge, so installed plugins with `read:content` resolve to `content:read` and reach the same code path.

  | Old                 | New                              |
  | ------------------- | -------------------------------- |
  | `read:content`      | `content:read`                   |
  | `write:content`     | `content:write`                  |
  | `read:media`        | `media:read`                     |
  | `write:media`       | `media:write`                    |
  | `read:users`        | `users:read`                     |
  | `network:fetch`     | `network:request`                |
  | `network:fetch:any` | `network:request:unrestricted`   |
  | `email:provide`     | `hooks.email-transport:register` |
  | `email:intercept`   | `hooks.email-events:register`    |
  | `page:inject`       | `hooks.page-fragments:register`  |

  Existing installs keep working — manifests are normalized at every external boundary and `diffCapabilities` normalizes both sides so version upgrades that only rename do not trigger a "capability changed" prompt. Deprecated names will be removed in the next minor.

### Patch Changes

- Updated dependencies [[`e2b3c6c`](https://github.com/emdash-cms/emdash/commit/e2b3c6cd930d5fa6fc607a0b26fd796f5b0f98b2), [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea), [`e0dc6fb`](https://github.com/emdash-cms/emdash/commit/e0dc6fb8adadc0e048f3f314d62bfa98d9bb48d4), [`c22fb3a`](https://github.com/emdash-cms/emdash/commit/c22fb3a10d445f12cca91620c9258d50695afa44), [`6a4e9b8`](https://github.com/emdash-cms/emdash/commit/6a4e9b8b0fa6064989224a42b14de435f487a76f), [`0ee372a`](https://github.com/emdash-cms/emdash/commit/0ee372a7f33eecce7d90e12624923d2d9c132adf), [`22a16ee`](https://github.com/emdash-cms/emdash/commit/22a16eed607a4e81391ecb6c45fe2e59aaca92fe), [`1e2b024`](https://github.com/emdash-cms/emdash/commit/1e2b02486ee0407e4f50b8342ba1a9e7d060e405), [`81662e9`](https://github.com/emdash-cms/emdash/commit/81662e98fcf1ad0ee880d4f1af96271c527d7423), [`2f22f57`](https://github.com/emdash-cms/emdash/commit/2f22f57abadf305cf6d3ce07ee78290178e032d1), [`ef3f076`](https://github.com/emdash-cms/emdash/commit/ef3f076c8112e9dffc2a87c019e5521e823f5e86), [`a9c29ea`](https://github.com/emdash-cms/emdash/commit/a9c29ea584300f6cf67206bedcb1d39f05ea1c26), [`e7df21f`](https://github.com/emdash-cms/emdash/commit/e7df21f0adca795cdb233d6e64cd543ead7e2347), [`d5f7c48`](https://github.com/emdash-cms/emdash/commit/d5f7c481a507868f470361cfd715a5828640d45a), [`8ae227c`](https://github.com/emdash-cms/emdash/commit/8ae227cceade5c9852897c7b56f89e7422ee82a1), [`e2d5d16`](https://github.com/emdash-cms/emdash/commit/e2d5d160acea4444945b1ea79c80ca9ce138965b), [`0d98c62`](https://github.com/emdash-cms/emdash/commit/0d98c620a5f407648f3b7f3cbd30b642c74be607), [`64bf5b9`](https://github.com/emdash-cms/emdash/commit/64bf5b98125ca18ec26f7e0e65a71fcbe71fd44f), [`e81aa0f`](https://github.com/emdash-cms/emdash/commit/e81aa0f717be11bacdff30ed9bbc454824268555), [`0041d76`](https://github.com/emdash-cms/emdash/commit/0041d7699b32b77b4cd2ecd77b97340f0dd3abce), [`cee403d`](https://github.com/emdash-cms/emdash/commit/cee403d5c008feb9ca60bb7201e151b828737743), [`a8bac5d`](https://github.com/emdash-cms/emdash/commit/a8bac5d7216e185b1bd9a2aaaeaa9a0306ab066e), [`5b6f059`](https://github.com/emdash-cms/emdash/commit/5b6f059d06175ae0cb740d1ba32867d1ec6b2249), [`a86ff80`](https://github.com/emdash-cms/emdash/commit/a86ff80836fed175508ff06f744c7ad6b805627c), [`d4be24f`](https://github.com/emdash-cms/emdash/commit/d4be24f478a0c8d0a7bba3c299e11105bba3ed94), [`eb6dbd0`](https://github.com/emdash-cms/emdash/commit/eb6dbd056717fd076a8b5fa807d91516a00f5f2f)]:
  - emdash@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49), [`0557b62`](https://github.com/emdash-cms/emdash/commit/0557b62ec646e49eeb5e28686d50b4e8746338be), [`5a581d9`](https://github.com/emdash-cms/emdash/commit/5a581d966cc1da72637a76ad42a7ac3b81ec59c3), [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14), [`3138432`](https://github.com/emdash-cms/emdash/commit/31384322537070db8c35e4f93f4ffe8225d784d6), [`70924cd`](https://github.com/emdash-cms/emdash/commit/70924cd19b4227b3a1ecfad6618f1a80530a378b), [`1f0f6f2`](https://github.com/emdash-cms/emdash/commit/1f0f6f2507d026f2b5c60c254432bfc327b3474f), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`f5658f0`](https://github.com/emdash-cms/emdash/commit/f5658f052f7294039f7ea8c5eb8b49af263beb0d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`b6cb2e6`](https://github.com/emdash-cms/emdash/commit/b6cb2e6c7001d37a0558e22953eba41013457528), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`cf1edae`](https://github.com/emdash-cms/emdash/commit/cf1edae6ac3e5cd8c72fd43a09bb80bae5cc8031), [`b352e88`](https://github.com/emdash-cms/emdash/commit/b352e881fedb7f6fdc35f9d75402f67caba7f154), [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd), [`da3d065`](https://github.com/emdash-cms/emdash/commit/da3d0656a4431365176cca65dc2bedf5eca19ce3), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`47978b5`](https://github.com/emdash-cms/emdash/commit/47978b5e1b69b671d2ea5c08ee0bbf4c72d1594d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd)]:
  - emdash@1.0.0

## 0.7.0

### Patch Changes

- [#740](https://github.com/emdash-cms/emdash/pull/740) [`63509e1`](https://github.com/emdash-cms/emdash/commit/63509e18f24f3ede3254065ba69d0177b1858555) Thanks [@ascorbic](https://github.com/ascorbic)! - Sandboxed plugin HTTP requests now follow redirects manually and re-validate the destination at every hop. The allowedHosts list is checked on each redirect target (not just the initial URL), so an allowed host that 302s to a disallowed one no longer bypasses the scope. Credential headers (Authorization, Cookie, Proxy-Authorization) are stripped on cross-origin redirects. `network:fetch:any` and `allowedHosts: ["*"]` now still reject literal private IPs, cloud-metadata addresses, and known internal hostnames — the allowlist scopes which public hosts a plugin may reach, not whether SSRF protection applies. Non-http(s) URL schemes are rejected. Caps redirect chains at 5 hops.

- Updated dependencies [[`8ebdf1a`](https://github.com/emdash-cms/emdash/commit/8ebdf1af65764cc4b72624e7758c4a666817aade), [`7186961`](https://github.com/emdash-cms/emdash/commit/7186961d3cbf706c1248e9e40b14b1a545ce8586), [`e9ecec2`](https://github.com/emdash-cms/emdash/commit/e9ecec2d2dfb20ab4c413fb593a09a9f6d0fb27e), [`e3e18aa`](https://github.com/emdash-cms/emdash/commit/e3e18aae92d31cf22efd11a0ba06110de24a076a), [`fae63bd`](https://github.com/emdash-cms/emdash/commit/fae63bdae8ff798a420379c36d3d05e54ea3628a), [`30d8fe0`](https://github.com/emdash-cms/emdash/commit/30d8fe00025e058c71c8bfcd296946bb2042c4a7), [`d4a95bf`](https://github.com/emdash-cms/emdash/commit/d4a95bf313855e97108dfec4de3ab35f1a85f8ba), [`a31db7d`](https://github.com/emdash-cms/emdash/commit/a31db7dcc6d9ddb09328eec815d255a4976ce3b8), [`adb118c`](https://github.com/emdash-cms/emdash/commit/adb118c99d867be7b17714798e1e565ccdf096e4), [`080a4f1`](https://github.com/emdash-cms/emdash/commit/080a4f1efdd793cddd49767d8b18cd53162f39e3), [`81fe93b`](https://github.com/emdash-cms/emdash/commit/81fe93bc675581ddd0161eaabbe7a3471ec76529), [`c26442b`](https://github.com/emdash-cms/emdash/commit/c26442be9887f1e3d3df37db5ccda6b260820a77)]:
  - emdash@0.7.0

## 0.6.0

### Patch Changes

- [#605](https://github.com/emdash-cms/emdash/pull/605) [`445b3bf`](https://github.com/emdash-cms/emdash/commit/445b3bfecf1f4cdc109be865685eb6ae6e0c06e6) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes D1 read replicas being bypassed for anonymous public page traffic. The middleware fast path now asks the database adapter for a per-request scoped Kysely, so anonymous reads land on the nearest replica instead of the primary-pinned singleton binding.

  All D1-specific semantics (Sessions API, constraint selection, bookmark cookie) live in `@emdash-cms/cloudflare/db/d1` behind a single `createRequestScopedDb(opts)` function. Core middleware has no D1-specific logic. Adapters opt in via a new `supportsRequestScope: boolean` flag on `DatabaseDescriptor`; `d1()` sets it to true.

  Other fixes in the same change:
  - Nested `runWithContext` calls in the request-context middleware now merge the parent context instead of replacing it, so an outer per-request db override is preserved through edit/preview flows.
  - Baseline security headers now forward Astro's cookie symbol across the response clone so `cookies.set()` calls in middleware survive.
  - Any write (authenticated or anonymous) now forces `first-primary`, so an anonymous form/comment POST isn't racing across replicas.
  - The session user is read once per request and reused in both the fast path and the full runtime init (previously read twice on authenticated public-page traffic).
  - Bookmark cookies are validated only for length (≤1024) and absence of control characters — no stricter shape check, so a future D1 bookmark format change won't silently degrade consistency.
  - The `!config` bail-out now still applies baseline security headers.
  - `__ec_d1_bookmark` references aligned to `__em_d1_bookmark` across runtime, docs, and JSDoc.

- [#569](https://github.com/emdash-cms/emdash/pull/569) [`134f776`](https://github.com/emdash-cms/emdash/commit/134f77673e59ea597b271c2bef74fd3eb5c38e0e) Thanks [@Yusaku01](https://github.com/Yusaku01)! - Fixes the playground toolbar layout on small screens.

- [#653](https://github.com/emdash-cms/emdash/pull/653) [`f97d6ab`](https://github.com/emdash-cms/emdash/commit/f97d6ab0f1995fe86862aeb20de65d0ee774699f) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds opt-in query instrumentation for performance regression testing. Setting `EMDASH_QUERY_LOG=1` causes the Kysely log hook to emit `[emdash-query-log]`-prefixed NDJSON on stdout for every DB query executed inside a request, tagged with the route, method, and an `X-Perf-Phase` header value. Zero runtime overhead when the flag is unset — the log option is only attached to Kysely when enabled.

  Also exposes the helpers at `emdash/database/instrumentation` so first-party adapters (e.g. `@emdash-cms/cloudflare`) can wire the same hook into their per-request Kysely instances.

- Updated dependencies [[`ada4ac7`](https://github.com/emdash-cms/emdash/commit/ada4ac7105f72a96eaf4ce3d884d705d8aba0119), [`f279320`](https://github.com/emdash-cms/emdash/commit/f279320ef49c68662c8936db15e21f46cb57e82b), [`7f75193`](https://github.com/emdash-cms/emdash/commit/7f75193df49967c871acdf47a22f0e48d2e98986), [`cfd01f3`](https://github.com/emdash-cms/emdash/commit/cfd01f3bd484b38549a5a164ad006279a2024788), [`38d637b`](https://github.com/emdash-cms/emdash/commit/38d637b520f8596758939ec08a7b534bb9550967), [`31d2f4e`](https://github.com/emdash-cms/emdash/commit/31d2f4edd5e84391e23f2eb6ff833e2fd4e51077), [`445b3bf`](https://github.com/emdash-cms/emdash/commit/445b3bfecf1f4cdc109be865685eb6ae6e0c06e6), [`943d540`](https://github.com/emdash-cms/emdash/commit/943d54060eb6675dda643b09f7cdb80bbbe5d566), [`2cb3165`](https://github.com/emdash-cms/emdash/commit/2cb31658037bc2b9ebfd3c5b82e4fb709b4a1fad), [`1859347`](https://github.com/emdash-cms/emdash/commit/18593475bb8e30ce1aab55d72903d02dbf3fd0cb), [`14c923b`](https://github.com/emdash-cms/emdash/commit/14c923b5eaf23f6e601cd2559ce9fc3af2f40822), [`c5ef0f5`](https://github.com/emdash-cms/emdash/commit/c5ef0f5befda129e4040822ee341f8cd8bb5acaf), [`f839381`](https://github.com/emdash-cms/emdash/commit/f8393819e74b31c269ba6c5088eab1f40b438c62), [`002d0ac`](https://github.com/emdash-cms/emdash/commit/002d0accd87fc0b6983a3a45fd11227398837366), [`0a61ef4`](https://github.com/emdash-cms/emdash/commit/0a61ef412ef8d2643fa847caeddbe8b8933d3fc7), [`6d41fe1`](https://github.com/emdash-cms/emdash/commit/6d41fe16539d09c53916b4ca41c515a29f8e0d4f), [`b158e40`](https://github.com/emdash-cms/emdash/commit/b158e40de596e8ca3cb056495276ec97403c24d9), [`f97d6ab`](https://github.com/emdash-cms/emdash/commit/f97d6ab0f1995fe86862aeb20de65d0ee774699f), [`e67b940`](https://github.com/emdash-cms/emdash/commit/e67b94056c21c716eada0fff7350b8592c6a3c68), [`0896ec8`](https://github.com/emdash-cms/emdash/commit/0896ec81065da7fa9b93053d366500805602c8fe), [`629fe1d`](https://github.com/emdash-cms/emdash/commit/629fe1dd3094a0178c57529a455a2be805b08ad0), [`f52154d`](https://github.com/emdash-cms/emdash/commit/f52154da8afb838b1af6deccf33b5a261257ec7c), [`8221c2a`](https://github.com/emdash-cms/emdash/commit/8221c2a3a37353b550f1c2c4a188bc4e2725b914), [`8fb93eb`](https://github.com/emdash-cms/emdash/commit/8fb93eb045eb529eafd83e451ec673106f5bdb3c), [`6d7f288`](https://github.com/emdash-cms/emdash/commit/6d7f288d812b554988742c36ef7a74be67386e6d), [`4ffa141`](https://github.com/emdash-cms/emdash/commit/4ffa141c00ec7b9785bbb86f9292055e46b22a61), [`04e6cca`](https://github.com/emdash-cms/emdash/commit/04e6ccaa939f184edf4129eea0edf8ac5185d018), [`9295cc1`](https://github.com/emdash-cms/emdash/commit/9295cc199f72c9b9adff236e4a72ba412604493f)]:
  - emdash@0.6.0

## 0.5.0

### Patch Changes

- [#543](https://github.com/emdash-cms/emdash/pull/543) [`7382c9d`](https://github.com/emdash-cms/emdash/commit/7382c9d432cb0823aa6f3282d30fa8a9bbb9e0d8) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes sandboxed plugin loading in Worker Loader by providing an `emdash` shim module

- Updated dependencies [[`82c6345`](https://github.com/emdash-cms/emdash/commit/82c63451ff05ddc0a8e2777c124907358814da2b), [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001), [`598026c`](https://github.com/emdash-cms/emdash/commit/598026c99083325c281b9e7ab87e9724e11f2c8d), [`197bc1b`](https://github.com/emdash-cms/emdash/commit/197bc1bdcb16012138a95b46a1e31530bde8c5ab), [`ce873f8`](https://github.com/emdash-cms/emdash/commit/ce873f8fa618aa175598726a60230b4c36d37e2e)]:
  - emdash@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`5beddc3`](https://github.com/emdash-cms/emdash/commit/5beddc31785aa7de086b2b22a2a9612f9d1c8aaf), [`8ed7969`](https://github.com/emdash-cms/emdash/commit/8ed7969df2c95790d7c635ef043df20bb21b6156), [`f866c9c`](https://github.com/emdash-cms/emdash/commit/f866c9cc0dd1ac62035ef3e06bbe8d8d7d1c44a0), [`1acf174`](https://github.com/emdash-cms/emdash/commit/1acf1743e7116a5f00b11536306ebb55edbf3b2e), [`678cc8c`](https://github.com/emdash-cms/emdash/commit/678cc8c4c34a23e8a7aeda652b0ec87070983b07), [`d56f6c1`](https://github.com/emdash-cms/emdash/commit/d56f6c1d2a688eee46e96a1dbe2d8c894ffc7095), [`5d9120e`](https://github.com/emdash-cms/emdash/commit/5d9120eca846dd7c446d05f1b9c14fe1b7e394ec), [`9318c56`](https://github.com/emdash-cms/emdash/commit/9318c5684fb293f167cd3e6f9e9a3ca12f042d7b), [`2a7c68a`](https://github.com/emdash-cms/emdash/commit/2a7c68a9f6c88216eb3f599b942b63fec8e1ae31), [`6492ea2`](https://github.com/emdash-cms/emdash/commit/6492ea202c5872132c952678862eb6f564c78b7c), [`b382357`](https://github.com/emdash-cms/emdash/commit/b38235702fd075d95c04b2a6874804ca45baa721), [`5c0776d`](https://github.com/emdash-cms/emdash/commit/5c0776deee7005ba580fc7dc8f778e805ab82cef), [`1b743ac`](https://github.com/emdash-cms/emdash/commit/1b743acc35750dc36de4acdd95164c34cd7d092f)]:
  - emdash@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`f2b3973`](https://github.com/emdash-cms/emdash/commit/f2b39739c13cbef86ed16be007f08abf86b0f9ca), [`13f5ff5`](https://github.com/emdash-cms/emdash/commit/13f5ff57ffbe89e330d55b3c9c25a1907bf94394), [`a283954`](https://github.com/emdash-cms/emdash/commit/a28395455cec14cea6d382a604e2598ead097d99), [`c70f66f`](https://github.com/emdash-cms/emdash/commit/c70f66f7da66311fcf2f5922f23cdf951cdaff5f), [`0b4e61b`](https://github.com/emdash-cms/emdash/commit/0b4e61b059e40d7fc56aceb63d43004c8872005d)]:
  - emdash@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`156ba73`](https://github.com/emdash-cms/emdash/commit/156ba7350070400e5877e3a54d33486cd0d33640), [`80a895b`](https://github.com/emdash-cms/emdash/commit/80a895b1def1bf8794f56e151e5ad7675225fae4), [`da957ce`](https://github.com/emdash-cms/emdash/commit/da957ce8ec18953995e6e00e0a38e5d830f1a381), [`fcd8b7b`](https://github.com/emdash-cms/emdash/commit/fcd8b7bebbd4342de6ca1d782a3ae4d42d1be913), [`8ac15a4`](https://github.com/emdash-cms/emdash/commit/8ac15a4ee450552f763d3c6d9d097941c57b8300), [`ba2b020`](https://github.com/emdash-cms/emdash/commit/ba2b0204d274cf1bbf89f724a99797660733203c), [`0b108cf`](https://github.com/emdash-cms/emdash/commit/0b108cf6286e5b41c134bbeca8a6cc834756b190), [`1989e8b`](https://github.com/emdash-cms/emdash/commit/1989e8b4c432a05d022baf2196dec2680b2e2fd0), [`e190324`](https://github.com/emdash-cms/emdash/commit/e1903248e0fccb1b34d0620b33e4f06eccdfe2a6), [`724191c`](https://github.com/emdash-cms/emdash/commit/724191cf96d5d79b22528a167de8c45146fb0746), [`ed28089`](https://github.com/emdash-cms/emdash/commit/ed28089bd296e1633ea048c7ca667cb5341f6aa6), [`a293708`](https://github.com/emdash-cms/emdash/commit/a2937083f8f74e32ad1b0383d9f22b20e18d7237), [`c75cc5b`](https://github.com/emdash-cms/emdash/commit/c75cc5b82cb678c5678859b249d545e12be6fd97), [`6ebb797`](https://github.com/emdash-cms/emdash/commit/6ebb7975be00a4d756cdb56955c88395840e3fec), [`d421ee2`](https://github.com/emdash-cms/emdash/commit/d421ee2cedfe48748148912ac7766fd841757dd6), [`391caf4`](https://github.com/emdash-cms/emdash/commit/391caf4a0f404f323b97c5d7f54f4a4d96aef349), [`6474dae`](https://github.com/emdash-cms/emdash/commit/6474daee29b6d0be289c995755658755d93316b1), [`30c9a96`](https://github.com/emdash-cms/emdash/commit/30c9a96404e913ea8b3039ef4a5bc70541647eec), [`122c236`](https://github.com/emdash-cms/emdash/commit/122c2364fc4cfc9082f036f9affcee13d9b00511), [`5320321`](https://github.com/emdash-cms/emdash/commit/5320321f5ee1c1f456b1c8c054f2d0232be58ecd), [`8f44ec2`](https://github.com/emdash-cms/emdash/commit/8f44ec23a4b23f636f9689c075d29edfa4962c7c), [`b712ae3`](https://github.com/emdash-cms/emdash/commit/b712ae3e5d8aec45e4d7a0f20f273795f7122715), [`9cb5a28`](https://github.com/emdash-cms/emdash/commit/9cb5a28001cc8e6d650ec6b45c9ea091a4e9e3c2), [`7ee7d95`](https://github.com/emdash-cms/emdash/commit/7ee7d95ee32df2b1915144030569382fe97aef3d), [`e1014ef`](https://github.com/emdash-cms/emdash/commit/e1014eff18301ff68ac75d19157d3500ebe890c5), [`4d4ac53`](https://github.com/emdash-cms/emdash/commit/4d4ac536eeb664b7d0ca9f1895a51960a47ecafe), [`476cb3a`](https://github.com/emdash-cms/emdash/commit/476cb3a585d30acb2d4d172f94c5d2b4e5b6377b), [`87b0439`](https://github.com/emdash-cms/emdash/commit/87b0439927454a275833992de4244678b47b9aa3), [`dd708b1`](https://github.com/emdash-cms/emdash/commit/dd708b1c0c35d43761f89a87cba74b3c0ecb777e), [`befaeec`](https://github.com/emdash-cms/emdash/commit/befaeecfefd968d14693e96e3cdaa691ffabe7d3), [`c92e7e6`](https://github.com/emdash-cms/emdash/commit/c92e7e6907a575d134a69ebbeed531b99569d599), [`2ba1f1f`](https://github.com/emdash-cms/emdash/commit/2ba1f1f8d1ff773889f980af35391187e3705f17), [`a13c4ec`](https://github.com/emdash-cms/emdash/commit/a13c4ec6e362abecdae62abe64b1aebebc06aaae), [`a5e0603`](https://github.com/emdash-cms/emdash/commit/a5e0603b1910481d042f5a22dd19a60c76da7197)]:
  - emdash@0.2.0

## 0.1.1

### Patch Changes

- [#200](https://github.com/emdash-cms/emdash/pull/200) [`422018a`](https://github.com/emdash-cms/emdash/commit/422018aeb227dffe3da7bfc772d86f9ce9c2bcd1) Thanks [@ascorbic](https://github.com/ascorbic)! - Replace placeholder text branding with proper EmDash logo SVGs across admin UI, playground loading page, and preview interstitial

- [#16](https://github.com/emdash-cms/emdash/pull/16) [`7924d54`](https://github.com/emdash-cms/emdash/commit/7924d54072094b394dc46d35da241bed36992da8) Thanks [@ascorbic](https://github.com/ascorbic)! - DIsplay an interstitial when loading playground

- Updated dependencies [[`422018a`](https://github.com/emdash-cms/emdash/commit/422018aeb227dffe3da7bfc772d86f9ce9c2bcd1), [`4221ba4`](https://github.com/emdash-cms/emdash/commit/4221ba48bc87ab9fa0b1bae144f6f2920beb4f5a), [`9269759`](https://github.com/emdash-cms/emdash/commit/9269759674bf254863f37d4cf1687fae56082063), [`d6cfc43`](https://github.com/emdash-cms/emdash/commit/d6cfc437f23e3e435a8862cab17d2c19363847d7), [`1bcfc50`](https://github.com/emdash-cms/emdash/commit/1bcfc502112d8756e34a720b8a170eb5486b425a), [`8c693b5`](https://github.com/emdash-cms/emdash/commit/8c693b582d7c5e29bd138161e81d9c8affb53689), [`5b3e33c`](https://github.com/emdash-cms/emdash/commit/5b3e33c26bc2eb30ab2a032960a5d57eb06f148a), [`9d10d27`](https://github.com/emdash-cms/emdash/commit/9d10d2791fe16be901d9d138e434bd79cf9335c4), [`91e31fb`](https://github.com/emdash-cms/emdash/commit/91e31fb2cab4c0470088c5d61bab6e2028821569), [`f112ac4`](https://github.com/emdash-cms/emdash/commit/f112ac48194d1c2302e93756d54b116d3d207c22), [`e9a6f7a`](https://github.com/emdash-cms/emdash/commit/e9a6f7ac3ceeaf5c2d0a557e4cf6cab5f3d7d764), [`b297fdd`](https://github.com/emdash-cms/emdash/commit/b297fdd88dadcabeb93f47abea9f24f70b7d4b71), [`d211452`](https://github.com/emdash-cms/emdash/commit/d2114523a55021f65ee46e44e11157b06334819e), [`8e28cfc`](https://github.com/emdash-cms/emdash/commit/8e28cfc5d66f58f0fb91aa35c02afdd426bb6555), [`38af118`](https://github.com/emdash-cms/emdash/commit/38af118ad517fd9aa83064368543bf64bc32c08a)]:
  - emdash@0.1.1

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release

### Patch Changes

- Updated dependencies [[`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4)]:
  - emdash@0.1.0

## 0.0.3

### Patch Changes

- Updated dependencies [[`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214)]:
  - emdash@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [[`b09bfd5`](https://github.com/emdash-cms/emdash/commit/b09bfd51cece5e88fe8314668a591ab11de36b4d)]:
  - emdash@0.0.2
