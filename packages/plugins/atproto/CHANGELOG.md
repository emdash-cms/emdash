# @emdash-cms/plugin-atproto

## 0.2.0

### Minor Changes

- [#1057](https://github.com/emdash-cms/emdash/pull/1057) [`c0ce915`](https://github.com/emdash-cms/emdash/commit/c0ce915c555b8658245d465255e2ec89b361c57f) Thanks [@ascorbic](https://github.com/ascorbic)! - **BREAKING:** Removes the `atprotoPlugin` named export and the factory call shape. Import the default export and pass it directly into `plugins:` or `sandboxed:`.

  ```diff
  - import { atprotoPlugin } from "@emdash-cms/plugin-atproto";
  + import atproto from "@emdash-cms/plugin-atproto";

    export default defineConfig({
    	integrations: [
    		emdash({
  - 			sandboxed: [atprotoPlugin()],
  + 			sandboxed: [atproto],
    		}),
    	],
    });
  ```

  Two changes: drop the `{ }` around the import, and drop the `()` after the plugin name. Per-install configuration moved to the admin UI's settings (KV-backed) when the sandboxed plugin redesign landed, so there's no longer a need for a factory call.

### Patch Changes

- Updated dependencies [[`6e62b90`](https://github.com/emdash-cms/emdash/commit/6e62b90e14615a2012a5885849e6b1d1062e7c0b), [`c0ce915`](https://github.com/emdash-cms/emdash/commit/c0ce915c555b8658245d465255e2ec89b361c57f), [`23597d0`](https://github.com/emdash-cms/emdash/commit/23597d017360673cf95eee8e5d24c873137fc215), [`883b75b`](https://github.com/emdash-cms/emdash/commit/883b75b992854a4e339d3896bbd73bec36180b9b), [`05440b1`](https://github.com/emdash-cms/emdash/commit/05440b11ef5df609ad7f800143fa96019da22101), [`94fb50b`](https://github.com/emdash-cms/emdash/commit/94fb50b0338d21037a6623de7f350a1621b1b811), [`0d5843f`](https://github.com/emdash-cms/emdash/commit/0d5843fc3378936667ab81c56001349198028ebb), [`0cd8c6d`](https://github.com/emdash-cms/emdash/commit/0cd8c6d4e0f0dc126d66f953afcfdc3d6201d00b), [`878a0b6`](https://github.com/emdash-cms/emdash/commit/878a0b689b9475e501f809d81d0fe494a040bfe4), [`121f173`](https://github.com/emdash-cms/emdash/commit/121f1735f06520468d1532efd9f9fba88ff5d295), [`f4a9711`](https://github.com/emdash-cms/emdash/commit/f4a9711d7e715b6f71129bf60665113052a52d60), [`dbaea9c`](https://github.com/emdash-cms/emdash/commit/dbaea9ccaef6ac48dda14b77c6b2adbe0dc0ff38), [`5681eb2`](https://github.com/emdash-cms/emdash/commit/5681eb2e43fbe57c535e5f828c1c8eba06b3eb89), [`ed917d9`](https://github.com/emdash-cms/emdash/commit/ed917d9d534751241dafb9126fd0beddbd5ed593), [`6e62b90`](https://github.com/emdash-cms/emdash/commit/6e62b90e14615a2012a5885849e6b1d1062e7c0b)]:
  - emdash@0.13.0

## 0.1.3

### Patch Changes

- [#918](https://github.com/emdash-cms/emdash/pull/918) [`1e0cb76`](https://github.com/emdash-cms/emdash/commit/1e0cb76899ce442fbc99f498fd2b57cb254c7c8d) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates declared capabilities to the current names (`content:read`, `content:write`, `media:read`, `media:write`, `network:request`, `network:request:unrestricted`) instead of the deprecated aliases. Plugin descriptors now report the package's own version instead of a stale hard-coded literal.

- Updated dependencies [[`a2d3658`](https://github.com/emdash-cms/emdash/commit/a2d3658e510f292bf1fbe6b0a9e8e4f02ebc1e03), [`c8a3a2c`](https://github.com/emdash-cms/emdash/commit/c8a3a2cce6bfdcdc6521556bcc507f88bd79ba31), [`699e1b3`](https://github.com/emdash-cms/emdash/commit/699e1b3d208a5ef4bca5dc3a40a39291e484f060), [`71f4e7d`](https://github.com/emdash-cms/emdash/commit/71f4e7d85b2568dbadd9dc6ff26160789cb24e47), [`7e32092`](https://github.com/emdash-cms/emdash/commit/7e32092596149ae2886bae34c8d2f4bad86dbe2f), [`2e2b8e9`](https://github.com/emdash-cms/emdash/commit/2e2b8e90c099f3422808f0e1da9c83a9ec533b64), [`9146931`](https://github.com/emdash-cms/emdash/commit/91469312df211304d51576c9aef621148707b6d3)]:
  - emdash@0.10.0

## 0.1.2

### Patch Changes

- [#734](https://github.com/emdash-cms/emdash/pull/734) [`cf1edae`](https://github.com/emdash-cms/emdash/commit/cf1edae6ac3e5cd8c72fd43a09bb80bae5cc8031) Thanks [@huckabarry](https://github.com/huckabarry)! - Fixes AT Protocol plugin setup by declaring the storage collection used by the sandbox implementation, normalizing pasted PDS URLs, and exposing the missing site name and publication sync controls in the admin page.

- Updated dependencies [[`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49), [`0557b62`](https://github.com/emdash-cms/emdash/commit/0557b62ec646e49eeb5e28686d50b4e8746338be), [`5a581d9`](https://github.com/emdash-cms/emdash/commit/5a581d966cc1da72637a76ad42a7ac3b81ec59c3), [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14), [`3138432`](https://github.com/emdash-cms/emdash/commit/31384322537070db8c35e4f93f4ffe8225d784d6), [`70924cd`](https://github.com/emdash-cms/emdash/commit/70924cd19b4227b3a1ecfad6618f1a80530a378b), [`1f0f6f2`](https://github.com/emdash-cms/emdash/commit/1f0f6f2507d026f2b5c60c254432bfc327b3474f), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`f5658f0`](https://github.com/emdash-cms/emdash/commit/f5658f052f7294039f7ea8c5eb8b49af263beb0d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`b6cb2e6`](https://github.com/emdash-cms/emdash/commit/b6cb2e6c7001d37a0558e22953eba41013457528), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`cf1edae`](https://github.com/emdash-cms/emdash/commit/cf1edae6ac3e5cd8c72fd43a09bb80bae5cc8031), [`b352e88`](https://github.com/emdash-cms/emdash/commit/b352e881fedb7f6fdc35f9d75402f67caba7f154), [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd), [`da3d065`](https://github.com/emdash-cms/emdash/commit/da3d0656a4431365176cca65dc2bedf5eca19ce3), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd), [`47978b5`](https://github.com/emdash-cms/emdash/commit/47978b5e1b69b671d2ea5c08ee0bbf4c72d1594d), [`3eca9d5`](https://github.com/emdash-cms/emdash/commit/3eca9d54be03a803d35e112f4114f85f53a23acd)]:
  - emdash@1.0.0

## 0.1.1

### Patch Changes

- [#363](https://github.com/emdash-cms/emdash/pull/363) [`91e31fb`](https://github.com/emdash-cms/emdash/commit/91e31fb2cab4c0470088c5d61bab6e2028821569) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes sandboxed plugin entries failing when package exports point to unbuilt TypeScript source. Adds build-time and bundle-time validation to catch misconfigured plugin exports early.

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
