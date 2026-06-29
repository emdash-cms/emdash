# @emdash-cms/auth-atproto

## 0.2.20

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.24.0

## 0.2.19

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.23.0

## 0.2.18

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.22.0

## 0.2.17

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.21.0

## 0.2.16

### Patch Changes

- [#1447](https://github.com/emdash-cms/emdash/pull/1447) [`141aa11`](https://github.com/emdash-cms/emdash/commit/141aa11213206d9ea5e14d1f1cd75c07cfacae7b) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes `@atcute` peer dependency warnings on install ([#1435](https://github.com/emdash-cms/emdash/issues/1435))

  Installing EmDash pulled in mismatched `@atcute` package versions, so `pnpm install` / `npm install` reported unmet peer warnings for `@atcute/identity` and `@atcute/lexicons`. The bundled `@atcute` dependencies are now aligned on v2 and installs are clean. If your project also depends on `@atcute` packages directly, note they have moved to v2 (`@atcute/client` 5, `@atcute/lexicons` 2, `@atcute/atproto` 4, `@atcute/oauth-node-client` 2).

- Updated dependencies []:
  - @emdash-cms/auth@0.20.0

## 0.2.15

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.19.0

## 0.2.14

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.18.0

## 0.2.13

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.17.2

## 0.2.12

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.17.1

## 0.2.11

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.17.0

## 0.2.10

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.16.1

## 0.2.9

### Patch Changes

- Updated dependencies []:
  - @emdash-cms/auth@0.16.0

## 0.2.8

### Patch Changes

- [#1177](https://github.com/emdash-cms/emdash/pull/1177) [`b9cc08e`](https://github.com/emdash-cms/emdash/commit/b9cc08e7556ccdbcbbcea6d3c06cae6abef18766) Thanks [@ascorbic](https://github.com/ascorbic)! - Bumps `@cloudflare/kumo` from 1.16 to 2.3. Two internal call sites picked up breaking API changes from Kumo 2.0: `Collapsible` is now a compound component (`Collapsible.Root` / `.DefaultTrigger` / `.DefaultPanel` instead of `<Collapsible label=...>`), used by the accordion block; and `ChartPalette.color()` was renamed to `ChartPalette.categorical()` in the chart block. No public API changes -- consumers see identical behaviour. Tests in `@emdash-cms/admin` that asserted on `Button`'s native `title` attribute now read `aria-label` instead, because Kumo 2 wraps `<Button title>` in a Tooltip popup rather than setting the DOM attribute.

- [#1139](https://github.com/emdash-cms/emdash/pull/1139) [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Upgrades `kysely` to `^0.29.0` (was `^0.27.0`) to resolve three high-severity advisories fixed in `>=0.28.17`:
  - GHSA-wmrf-hv6w-mr66 – SQL injection via unsanitized JSON path keys
  - GHSA-pv5w-4p9q-p3v2 – JSON-path traversal injection via `JSONPathBuilder.key()` / `.at()`
  - GHSA-8cpq-38p9-67gx – MySQL SQL injection via `sql.lit(string)`

  Also updates import paths for `Migrator` and `Migration` types to `kysely/migration` to comply with kysely 0.29 export changes.

- Updated dependencies [[`02ed8ba`](https://github.com/emdash-cms/emdash/commit/02ed8ba32ef1f4301d84465b934430eee08eef74), [`11b3001`](https://github.com/emdash-cms/emdash/commit/11b300100e066c6b3463070a9b65fba868f37e9b), [`fae97ee`](https://github.com/emdash-cms/emdash/commit/fae97ee5465934365864557e9fa3ee8754cfd49c), [`88f544d`](https://github.com/emdash-cms/emdash/commit/88f544db4b8e2f30060a3b4d670ff72aa8760d61), [`9a30607`](https://github.com/emdash-cms/emdash/commit/9a30607791a2f27473b1d2fe7700291e0be1ea1c), [`d0ff94b`](https://github.com/emdash-cms/emdash/commit/d0ff94bd476e7fd4b5d18c94904cfb5c071fea92)]:
  - emdash@0.15.0
  - @emdash-cms/auth@0.15.0

## 0.2.7

### Patch Changes

- Updated dependencies [[`cf85941`](https://github.com/emdash-cms/emdash/commit/cf85941c1c631d355ca4df216e790ecf75420bbe), [`cf85941`](https://github.com/emdash-cms/emdash/commit/cf85941c1c631d355ca4df216e790ecf75420bbe), [`3756168`](https://github.com/emdash-cms/emdash/commit/37561682224447c7280648dc770ab408afc4186a)]:
  - emdash@0.14.0
  - @emdash-cms/auth@0.14.0

## 0.2.6

### Patch Changes

- Updated dependencies [[`6e62b90`](https://github.com/emdash-cms/emdash/commit/6e62b90e14615a2012a5885849e6b1d1062e7c0b), [`c0ce915`](https://github.com/emdash-cms/emdash/commit/c0ce915c555b8658245d465255e2ec89b361c57f), [`23597d0`](https://github.com/emdash-cms/emdash/commit/23597d017360673cf95eee8e5d24c873137fc215), [`883b75b`](https://github.com/emdash-cms/emdash/commit/883b75b992854a4e339d3896bbd73bec36180b9b), [`05440b1`](https://github.com/emdash-cms/emdash/commit/05440b11ef5df609ad7f800143fa96019da22101), [`94fb50b`](https://github.com/emdash-cms/emdash/commit/94fb50b0338d21037a6623de7f350a1621b1b811), [`0d5843f`](https://github.com/emdash-cms/emdash/commit/0d5843fc3378936667ab81c56001349198028ebb), [`0cd8c6d`](https://github.com/emdash-cms/emdash/commit/0cd8c6d4e0f0dc126d66f953afcfdc3d6201d00b), [`878a0b6`](https://github.com/emdash-cms/emdash/commit/878a0b689b9475e501f809d81d0fe494a040bfe4), [`121f173`](https://github.com/emdash-cms/emdash/commit/121f1735f06520468d1532efd9f9fba88ff5d295), [`f4a9711`](https://github.com/emdash-cms/emdash/commit/f4a9711d7e715b6f71129bf60665113052a52d60), [`dbaea9c`](https://github.com/emdash-cms/emdash/commit/dbaea9ccaef6ac48dda14b77c6b2adbe0dc0ff38), [`5681eb2`](https://github.com/emdash-cms/emdash/commit/5681eb2e43fbe57c535e5f828c1c8eba06b3eb89), [`ed917d9`](https://github.com/emdash-cms/emdash/commit/ed917d9d534751241dafb9126fd0beddbd5ed593), [`6e62b90`](https://github.com/emdash-cms/emdash/commit/6e62b90e14615a2012a5885849e6b1d1062e7c0b)]:
  - emdash@0.13.0
  - @emdash-cms/auth@0.13.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`35791ff`](https://github.com/emdash-cms/emdash/commit/35791ff9f68c10c6d3ff15ee0ab407baef09c2aa), [`7b45cba`](https://github.com/emdash-cms/emdash/commit/7b45cba66143c3a75bbd880abff85303c1fd6072)]:
  - emdash@0.12.0
  - @emdash-cms/auth@0.12.0

## 0.2.4

### Patch Changes

- Updated dependencies [[`dc44989`](https://github.com/emdash-cms/emdash/commit/dc44989b263164625039525aa84e4a562f0a879f)]:
  - emdash@0.11.1
  - @emdash-cms/auth@0.11.1

## 0.2.3

### Patch Changes

- Updated dependencies [[`f8ee1ed`](https://github.com/emdash-cms/emdash/commit/f8ee1ed5e7b02b8905ebec82fb703e3061fe8161), [`27e6d58`](https://github.com/emdash-cms/emdash/commit/27e6d58ec1ba547ece4736ac0a87309812a95681), [`4c11017`](https://github.com/emdash-cms/emdash/commit/4c11017b833e4c009562b6063fd1fe281639f168), [`f1d4c0b`](https://github.com/emdash-cms/emdash/commit/f1d4c0bfc475ef947f0f4f00d171ab226f89dc6c), [`7c536e5`](https://github.com/emdash-cms/emdash/commit/7c536e59b005a79925dd0ecab46404d9d34196b8), [`d273e9a`](https://github.com/emdash-cms/emdash/commit/d273e9a3d3dff6e356bc17dd3e22d294e9635b03), [`514d32d`](https://github.com/emdash-cms/emdash/commit/514d32d97c11a56cd501f4a45a33524b31badd49), [`8116949`](https://github.com/emdash-cms/emdash/commit/8116949935d7b713ebcb3858435c29e45c00c090), [`c4ee7ad`](https://github.com/emdash-cms/emdash/commit/c4ee7ad838c5fcbc7939fe8102cd87d5d6856e68)]:
  - @emdash-cms/auth@0.11.0
  - emdash@0.11.0

## 0.2.2

### Patch Changes

- Updated dependencies [[`a2d3658`](https://github.com/emdash-cms/emdash/commit/a2d3658e510f292bf1fbe6b0a9e8e4f02ebc1e03), [`c8a3a2c`](https://github.com/emdash-cms/emdash/commit/c8a3a2cce6bfdcdc6521556bcc507f88bd79ba31), [`699e1b3`](https://github.com/emdash-cms/emdash/commit/699e1b3d208a5ef4bca5dc3a40a39291e484f060), [`71f4e7d`](https://github.com/emdash-cms/emdash/commit/71f4e7d85b2568dbadd9dc6ff26160789cb24e47), [`7e32092`](https://github.com/emdash-cms/emdash/commit/7e32092596149ae2886bae34c8d2f4bad86dbe2f), [`2e2b8e9`](https://github.com/emdash-cms/emdash/commit/2e2b8e90c099f3422808f0e1da9c83a9ec533b64), [`9146931`](https://github.com/emdash-cms/emdash/commit/91469312df211304d51576c9aef621148707b6d3)]:
  - emdash@0.10.0
  - @emdash-cms/auth@0.10.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`e2b3c6c`](https://github.com/emdash-cms/emdash/commit/e2b3c6cd930d5fa6fc607a0b26fd796f5b0f98b2), [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea), [`e0dc6fb`](https://github.com/emdash-cms/emdash/commit/e0dc6fb8adadc0e048f3f314d62bfa98d9bb48d4), [`c22fb3a`](https://github.com/emdash-cms/emdash/commit/c22fb3a10d445f12cca91620c9258d50695afa44), [`6a4e9b8`](https://github.com/emdash-cms/emdash/commit/6a4e9b8b0fa6064989224a42b14de435f487a76f), [`0ee372a`](https://github.com/emdash-cms/emdash/commit/0ee372a7f33eecce7d90e12624923d2d9c132adf), [`22a16ee`](https://github.com/emdash-cms/emdash/commit/22a16eed607a4e81391ecb6c45fe2e59aaca92fe), [`1e2b024`](https://github.com/emdash-cms/emdash/commit/1e2b02486ee0407e4f50b8342ba1a9e7d060e405), [`81662e9`](https://github.com/emdash-cms/emdash/commit/81662e98fcf1ad0ee880d4f1af96271c527d7423), [`2f22f57`](https://github.com/emdash-cms/emdash/commit/2f22f57abadf305cf6d3ce07ee78290178e032d1), [`ef3f076`](https://github.com/emdash-cms/emdash/commit/ef3f076c8112e9dffc2a87c019e5521e823f5e86), [`a9c29ea`](https://github.com/emdash-cms/emdash/commit/a9c29ea584300f6cf67206bedcb1d39f05ea1c26), [`e7df21f`](https://github.com/emdash-cms/emdash/commit/e7df21f0adca795cdb233d6e64cd543ead7e2347), [`d5f7c48`](https://github.com/emdash-cms/emdash/commit/d5f7c481a507868f470361cfd715a5828640d45a), [`8ae227c`](https://github.com/emdash-cms/emdash/commit/8ae227cceade5c9852897c7b56f89e7422ee82a1), [`e2d5d16`](https://github.com/emdash-cms/emdash/commit/e2d5d160acea4444945b1ea79c80ca9ce138965b), [`0d98c62`](https://github.com/emdash-cms/emdash/commit/0d98c620a5f407648f3b7f3cbd30b642c74be607), [`64bf5b9`](https://github.com/emdash-cms/emdash/commit/64bf5b98125ca18ec26f7e0e65a71fcbe71fd44f), [`e81aa0f`](https://github.com/emdash-cms/emdash/commit/e81aa0f717be11bacdff30ed9bbc454824268555), [`0041d76`](https://github.com/emdash-cms/emdash/commit/0041d7699b32b77b4cd2ecd77b97340f0dd3abce), [`cee403d`](https://github.com/emdash-cms/emdash/commit/cee403d5c008feb9ca60bb7201e151b828737743), [`a8bac5d`](https://github.com/emdash-cms/emdash/commit/a8bac5d7216e185b1bd9a2aaaeaa9a0306ab066e), [`5b6f059`](https://github.com/emdash-cms/emdash/commit/5b6f059d06175ae0cb740d1ba32867d1ec6b2249), [`a86ff80`](https://github.com/emdash-cms/emdash/commit/a86ff80836fed175508ff06f744c7ad6b805627c), [`d4be24f`](https://github.com/emdash-cms/emdash/commit/d4be24f478a0c8d0a7bba3c299e11105bba3ed94), [`eb6dbd0`](https://github.com/emdash-cms/emdash/commit/eb6dbd056717fd076a8b5fa807d91516a00f5f2f)]:
  - emdash@0.9.0
  - @emdash-cms/auth@0.9.0

## 0.2.0

### Minor Changes

- [#398](https://github.com/emdash-cms/emdash/pull/398) [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd) Thanks [@simnaut](https://github.com/simnaut)! - Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.

### Patch Changes

- Updated dependencies [[`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49), [`0557b62`](https://github.com/emdash-cms/emdash/commit/0557b62ec646e49eeb5e28686d50b4e8746338be), [`5a581d9`](https://github.com/emdash-cms/emdash/commit/5a581d966cc1da72637a76ad42a7ac3b81ec59c3), [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14), [`3138432`](https://github.com/emdash-cms/emdash/commit/31384322537070db8c35e4f93f4ffe8225d784d6), [`70924cd`](https://github.com/emdash-cms/emdash/commit/70924cd19b4227b3a1ecfad6618f1a80530a378b), [`1f0f6f2`](https://github.com/emdash-cms/emdash/commit/1f0f6f2507d026f2b5c60c254432bfc327b3474f), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`f5658f0`](https://github.com/emdash-cms/emdash/commit/f5658f052f7294039f7ea8c5eb8b49af263beb0d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`b6cb2e6`](https://github.com/emdash-cms/emdash/commit/b6cb2e6c7001d37a0558e22953eba41013457528), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`cf1edae`](https://github.com/emdash-cms/emdash/commit/cf1edae6ac3e5cd8c72fd43a09bb80bae5cc8031), [`b352e88`](https://github.com/emdash-cms/emdash/commit/b352e881fedb7f6fdc35f9d75402f67caba7f154), [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd), [`da3d065`](https://github.com/emdash-cms/emdash/commit/da3d0656a4431365176cca65dc2bedf5eca19ce3), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`47978b5`](https://github.com/emdash-cms/emdash/commit/47978b5e1b69b671d2ea5c08ee0bbf4c72d1594d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd)]:
  - emdash@1.0.0
  - @emdash-cms/auth@1.0.0
