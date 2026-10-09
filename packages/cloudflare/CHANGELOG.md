# @emdash-cms/cloudflare

<!-- emdash-changelog-archive: ./changelog/0.0.2-to-0.23.0.md -->

## 1.2.0

### Minor Changes

- [#3875](https://github.com/emdash-cms/emdash/pull/3875) [`0a17191`](https://github.com/emdash-cms/emdash/commit/0a171919fd68507516f6a50c951336817b25165f) Thanks [@swissky](https://github.com/swissky)! - Adds a `syncName` option to external auth providers such as Cloudflare Access. By default, EmDash still replaces a user's name with the provider's name on every authenticated request, so a name edited in the admin is restored on that user's next request. Set `syncName: false` to keep names edited in the admin; the provider's name is then used only when the user is first provisioned.
  
  ```js
  auth: access({
  	teamDomain: "myteam.cloudflareaccess.com",
  	syncName: false,
  }),
  ```

### Patch Changes

- [#3828](https://github.com/emdash-cms/emdash/pull/3828) [`609c912`](https://github.com/emdash-cms/emdash/commit/609c91298940ccee0566d1eb14e01c0f7ff51967) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes videos served from `/_emdash/api/media/file/` not playing in Safari and on iOS, and not seeking past the buffered part in other browsers. With the local, S3, and R2 storage adapters, the media route answers `Range` requests with `206 Partial Content`, or `416 Range Not Satisfiable` for a range past the end of the file, and sends `Accept-Ranges: bytes`.
  
  Custom storage adapters can serve ranges by accepting the optional `options.range` argument to `download()` and setting `range` on the result, as described in [the storage interface docs](https://docs.emdashcms.com/deployment/storage/#byte-ranges). Adapters that ignore the argument still work: range requests to them receive the whole file, or `416` for a range past the end of the file.

- [#3855](https://github.com/emdash-cms/emdash/pull/3855) [`e8b61b3`](https://github.com/emdash-cms/emdash/commit/e8b61b304e33c18c77dd7b85cc9960a16cb41f4e) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Adds `ETag` and `Last-Modified` validators to media file responses and `/image` transforms, and returns `304 Not Modified` when a browser's `If-None-Match` or `If-Modified-Since` precondition matches. This lets cached mutable media (images that can be replaced under the same storage key) be revalidated with a single header exchange instead of re-downloaded on every visit. Storage backends now report `lastModified` with downloads where available (local filesystem, S3-compatible, and R2). The short `public, max-age=0, must-revalidate` cache lifetime for images is unchanged, so replacements still appear immediately.

- [#3776](https://github.com/emdash-cms/emdash/pull/3776) [`9f389fb`](https://github.com/emdash-cms/emdash/commit/9f389fb1e95a4c4d24b02ec0deb14c5a65604431) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fixes plugin `ctx.storage.<collection>.getMany()` and `deleteMany()` failing on D1 with `too many SQL variables` when passed more than 98 ids. Both now accept any number of ids, in trusted and sandboxed plugins alike.

- [#3681](https://github.com/emdash-cms/emdash/pull/3681) [`cfc7e7d`](https://github.com/emdash-cms/emdash/commit/cfc7e7d95677caf177f12fa338e2c9599d3633c5) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes stored cross-site scripting through the editor toolbar. EmDash inserted the toolbar before the first `</body>` in a response, but Astro leaves `<` and `>` unescaped in attribute values, so content such as an image's alt text could contain `</body>` and move the toolbar inside that attribute, turning the rest of the text into live markup. The editor toolbar, and the Cloudflare preview and playground toolbars, now go only before the closing body tag of a whole HTML document, never into server island or partial page responses.
  
  Before this fix:
  
  - Unless a site set `toolbar: false`, an Author's published content could run script for any signed-in Author, Editor, or Admin who viewed it, and a Contributor's draft could do the same to a signed-in Author, Editor, or Admin who previewed it.
  - With `toolbar: "client"`, published content could also run script for every visitor.
  - In preview Workers built with `createPreviewMiddleware`, published content could run script for anyone who opened a preview link, whatever the `toolbar` setting.
- Updated dependencies [[`d22f62f`](https://github.com/emdash-cms/emdash/commit/d22f62fb46844e377eec4fd331f5071df3d76467), [`b92f2d6`](https://github.com/emdash-cms/emdash/commit/b92f2d653689984b804998633276d1bdd7ccec89), [`5f69896`](https://github.com/emdash-cms/emdash/commit/5f69896ade7567f8af99373ef655046d6b823518), [`04a3d8d`](https://github.com/emdash-cms/emdash/commit/04a3d8db8d1c88b889167a1567a5d7a2ef76332d), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`36b46d9`](https://github.com/emdash-cms/emdash/commit/36b46d9431fac3787396b0db2d42474530a41e91), [`f09797c`](https://github.com/emdash-cms/emdash/commit/f09797c847778e29a697f83ae76f9e7f253cbdcf), [`cd21162`](https://github.com/emdash-cms/emdash/commit/cd211628e602471c63cf3c46f1206722d1dd1de8), [`e3a9de3`](https://github.com/emdash-cms/emdash/commit/e3a9de322736de8398225225f5909bff07bf4e1e), [`0742f27`](https://github.com/emdash-cms/emdash/commit/0742f27408d14bfba8477063f36c26357483cedc), [`5b01664`](https://github.com/emdash-cms/emdash/commit/5b016649799b681a531d19be213abf7c97c7ad57), [`4b2b6e4`](https://github.com/emdash-cms/emdash/commit/4b2b6e4591abc8a4782399aecfc8b2755536fea2), [`47cb798`](https://github.com/emdash-cms/emdash/commit/47cb7985ec0d0dfc0643a15a64ba85c4700fd9ef), [`c4e6737`](https://github.com/emdash-cms/emdash/commit/c4e6737c937acacd240d634d6df116843ad0a6f1), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`373446f`](https://github.com/emdash-cms/emdash/commit/373446f973d33703718f2f0c22322548fad6ab1a), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`0a17191`](https://github.com/emdash-cms/emdash/commit/0a171919fd68507516f6a50c951336817b25165f), [`709dbf4`](https://github.com/emdash-cms/emdash/commit/709dbf42dbc6764057c5eceb8997ff4131ef047a), [`038e322`](https://github.com/emdash-cms/emdash/commit/038e3228773132a753172968b33ec413dcff3f5c), [`b9613bd`](https://github.com/emdash-cms/emdash/commit/b9613bd4bbf2bd5ecc1935279821c37b43445a6e), [`6cf612c`](https://github.com/emdash-cms/emdash/commit/6cf612cbf2a04a7eb1b22cb3e4ffecb53a1a438a), [`8450114`](https://github.com/emdash-cms/emdash/commit/845011455d8badcede71d4a2c994b1c492b197be), [`3bcd2cb`](https://github.com/emdash-cms/emdash/commit/3bcd2cbb949b6eb69182446cc6c49a38cf156d7f), [`9ee7415`](https://github.com/emdash-cms/emdash/commit/9ee7415a35c01ae2591af1a1c21787ca694b9c99), [`36aee2d`](https://github.com/emdash-cms/emdash/commit/36aee2d17225a44cd4060f1ae158e723e3730372), [`da088aa`](https://github.com/emdash-cms/emdash/commit/da088aa96ac11c6f65af889f7272c76d24a3e736), [`609c912`](https://github.com/emdash-cms/emdash/commit/609c91298940ccee0566d1eb14e01c0f7ff51967), [`a834e75`](https://github.com/emdash-cms/emdash/commit/a834e75327368f24a42f358564c316449c9503e1), [`e2a07ae`](https://github.com/emdash-cms/emdash/commit/e2a07ae1b02951d77a32341302ff5c504cb52b1c), [`e8b61b3`](https://github.com/emdash-cms/emdash/commit/e8b61b304e33c18c77dd7b85cc9960a16cb41f4e), [`d0c7384`](https://github.com/emdash-cms/emdash/commit/d0c73843245234ea1230d570b1ed9f586f6698c1), [`e6fe5d4`](https://github.com/emdash-cms/emdash/commit/e6fe5d498a527b5e6bd6cbc80ee5220ce626673c), [`c3cc974`](https://github.com/emdash-cms/emdash/commit/c3cc97432fb76098d918eefdf3676e45f60d52c6), [`07f6f44`](https://github.com/emdash-cms/emdash/commit/07f6f443fa16fb0fd2f50fea85039d216e0345df), [`2c8c12a`](https://github.com/emdash-cms/emdash/commit/2c8c12a6b84d7c790944aebd5e7e090514fccfd6), [`82cea2c`](https://github.com/emdash-cms/emdash/commit/82cea2cd54ee14506d043818a423cfc58f339c54), [`4bc129c`](https://github.com/emdash-cms/emdash/commit/4bc129ce6e36041596b63c59e680a5dca7838a1d), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`9f389fb`](https://github.com/emdash-cms/emdash/commit/9f389fb1e95a4c4d24b02ec0deb14c5a65604431), [`9538600`](https://github.com/emdash-cms/emdash/commit/95386001e4ac5a964fb568fa3d75113fe539e0fe), [`d8c6d64`](https://github.com/emdash-cms/emdash/commit/d8c6d643d64ca762012b3bfc319ab41d6827d92f), [`aa7cc95`](https://github.com/emdash-cms/emdash/commit/aa7cc95e2f0037ef6ab80b8beb48704a733368ae), [`e9cf2c3`](https://github.com/emdash-cms/emdash/commit/e9cf2c3ff804b54ccfdceb2fbe93e74e26799833), [`766aa29`](https://github.com/emdash-cms/emdash/commit/766aa29f25246486c8ba0673db23227cf366c1aa), [`f223ecd`](https://github.com/emdash-cms/emdash/commit/f223ecdc060038ffb75363a4e10ef341d065e5ca), [`34f480e`](https://github.com/emdash-cms/emdash/commit/34f480ecc1662d61c4608fc61dfaf606b9e6d7d6), [`f6ee57e`](https://github.com/emdash-cms/emdash/commit/f6ee57e92445d7c01df6863968875cb979bfae87), [`9451267`](https://github.com/emdash-cms/emdash/commit/94512678307b592dbdee9c8715e7a6600827b1dc), [`3d5a102`](https://github.com/emdash-cms/emdash/commit/3d5a1024cd7f9266b39bdb8f8d974d586e2bd302), [`0157a63`](https://github.com/emdash-cms/emdash/commit/0157a6300e5351efcdde191bd1f175b1e31ac1aa), [`064f46c`](https://github.com/emdash-cms/emdash/commit/064f46ce298a3dc123fea3638d1edbb8764cdbce), [`bafa475`](https://github.com/emdash-cms/emdash/commit/bafa475cc7de266f7bd3ea1486ee286808fc2e0f), [`7f3093e`](https://github.com/emdash-cms/emdash/commit/7f3093ef9f4523ba6323c7c5d95ae16e67a7ae41), [`3bfd6fc`](https://github.com/emdash-cms/emdash/commit/3bfd6fc1965f21700b23355499866980e90fece4), [`1e275ae`](https://github.com/emdash-cms/emdash/commit/1e275ae8b4f1a2766c2f29d2efa8d5a8492233d6), [`1bad6d8`](https://github.com/emdash-cms/emdash/commit/1bad6d8414aa98315c9d1ff33e1a1598e8ac45ae), [`4f967ae`](https://github.com/emdash-cms/emdash/commit/4f967aed349096c749ac64e16bb03188aa4d5a1e), [`d5b8b38`](https://github.com/emdash-cms/emdash/commit/d5b8b38e422f04fbda02b2c17e4f0d599a6e2ff9), [`cfc7e7d`](https://github.com/emdash-cms/emdash/commit/cfc7e7d95677caf177f12fa338e2c9599d3633c5), [`f4dc955`](https://github.com/emdash-cms/emdash/commit/f4dc955453d021f1cc2f245f1468677f9302b659), [`550e59b`](https://github.com/emdash-cms/emdash/commit/550e59b51ab4d0bc3ad3ab13e70d94ca96313863), [`ea88e8e`](https://github.com/emdash-cms/emdash/commit/ea88e8e3801ff127c111c85b2872a93d89a3b641), [`740de2b`](https://github.com/emdash-cms/emdash/commit/740de2b1b42f1d871b91195bc3bbfc9e5e869df6), [`161ff98`](https://github.com/emdash-cms/emdash/commit/161ff98663cb8b5ade88d16154e2bf8f8ed43516), [`f715431`](https://github.com/emdash-cms/emdash/commit/f7154317cdc5ce26dfee837c391b32a665e846ee), [`622a324`](https://github.com/emdash-cms/emdash/commit/622a324788784890377c355acc3c2a5ec65daec5)]:
  - emdash@1.2.0

## 1.1.0

### Patch Changes

- [#3633](https://github.com/emdash-cms/emdash/pull/3633) [`33a00e4`](https://github.com/emdash-cms/emdash/commit/33a00e4abf409edff8e67d1f92f530423b75050a) Thanks [@koikar](https://github.com/koikar)! - Fixes Kysely `numAffectedRows` on the Durable Object SQL database backend and the preview database: writes now report the number of changed table rows (SQLite `changes()`) instead of `rowsWritten`, which also counts index entries. This resolves false `stale` outcomes when fencing a collection for deletion with media-usage tracking enabled, and fixes any other `numAffectedRows` / `numUpdatedRows` comparisons against indexed tables.
- Updated dependencies [[`75de9a4`](https://github.com/emdash-cms/emdash/commit/75de9a4b4bdb3a8298456b4b730aee31c86897fd), [`2d84db5`](https://github.com/emdash-cms/emdash/commit/2d84db536174436637f3223ef1885653479248a0), [`2436119`](https://github.com/emdash-cms/emdash/commit/24361197b40bdde7aa5efba2ee53165f801ca3d2), [`3c70ca5`](https://github.com/emdash-cms/emdash/commit/3c70ca524abc3f70fe65a1753dbc4d10114fc816), [`76b06d4`](https://github.com/emdash-cms/emdash/commit/76b06d4e40a9d37ab44ec7109e75339af7aeef85), [`a880323`](https://github.com/emdash-cms/emdash/commit/a88032398d25a93c8159392e4bad4c495f5cd89a), [`0cfa989`](https://github.com/emdash-cms/emdash/commit/0cfa989bcfc1914caa4b11e92170154fdaef1ec1), [`2ef2d01`](https://github.com/emdash-cms/emdash/commit/2ef2d0194ea4dee6620eda0eaadcc649bf72def7), [`02da2bd`](https://github.com/emdash-cms/emdash/commit/02da2bd4cb6690aa0ffc9ba62404567af164f9ad), [`ea3c927`](https://github.com/emdash-cms/emdash/commit/ea3c927a994e64d43ea718fa38449e3170ac2b90), [`5de3bdc`](https://github.com/emdash-cms/emdash/commit/5de3bdc4310f6bcca013f05002f05a61e208b2a4), [`02da2bd`](https://github.com/emdash-cms/emdash/commit/02da2bd4cb6690aa0ffc9ba62404567af164f9ad), [`02da2bd`](https://github.com/emdash-cms/emdash/commit/02da2bd4cb6690aa0ffc9ba62404567af164f9ad), [`7583f9b`](https://github.com/emdash-cms/emdash/commit/7583f9bba933e50eb783d68d6efb0bf1b048a627), [`73304f4`](https://github.com/emdash-cms/emdash/commit/73304f42a1b1b689b3d121b4d9f021eca51c4fb2), [`2a0cb93`](https://github.com/emdash-cms/emdash/commit/2a0cb93ebe2c74306762c4116fb2e02d49fdf6b2), [`d1b4402`](https://github.com/emdash-cms/emdash/commit/d1b4402b0fdafcc49ea603dbc1dffd70ee24e06a), [`1d93e7c`](https://github.com/emdash-cms/emdash/commit/1d93e7c66871a9aa796f9d7e2db144b55b4e1b2d), [`0a5c604`](https://github.com/emdash-cms/emdash/commit/0a5c604fe419419ed97a72b69272d6d94d13b4dd), [`7d06f5d`](https://github.com/emdash-cms/emdash/commit/7d06f5d4dfb5df8d81e33b6d42a341e61368bafe), [`189c6b3`](https://github.com/emdash-cms/emdash/commit/189c6b31566c5bcf3b2eb48972f1ee346d175503), [`f925a89`](https://github.com/emdash-cms/emdash/commit/f925a89feca7dcea4c2026cf840673a4594d2015), [`a40b7ce`](https://github.com/emdash-cms/emdash/commit/a40b7ce52ed205c61624b5c291a0a2388f1b9280), [`6940899`](https://github.com/emdash-cms/emdash/commit/69408991639957d25b4de3290f131fa43bd0b27e), [`0b9426e`](https://github.com/emdash-cms/emdash/commit/0b9426e1bffa435f40388bb4864acd8d0d5bc989), [`728790b`](https://github.com/emdash-cms/emdash/commit/728790b099b4a9322cea94ff72216340d7ebc8f7)]:
  - emdash@1.1.0

## 1.0.1

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. Before upgrading from 0.42, read the [upgrade guide](https://docs.emdashcms.com/upgrade-to-v1/), which lists each change and how to migrate.
  
  From this release, breaking changes ship only in a new major version.

- [#3518](https://github.com/emdash-cms/emdash/pull/3518) [`bc54886`](https://github.com/emdash-cms/emdash/commit/bc5488685c8a886e2375d066d7424ddf4aac9a78) Thanks [@ascorbic](https://github.com/ascorbic)! - Moves the subpaths that only EmDash itself loads under `emdash/internal/`, and the D1 and Hyperdrive migration executors under `@emdash-cms/cloudflare/internal/`. These paths are not public API: their exports can change or be removed in any release.
  
  Sites that use `emdash()` in `astro.config.mjs` need no changes. The integration, the database, cache and media adapter helpers, and the first-party Cloudflare, workerd sandbox and plugin-test packages all load the new paths automatically.
  
  The following subpaths are removed:
  
  | Removed subpath                                   | Now loaded from                                            |
  | ------------------------------------------------- | ---------------------------------------------------------- |
  | `emdash/routes/*`                                 | `emdash/internal/routes/*`                                 |
  | `emdash/middleware/auth`                          | `emdash/internal/middleware/auth`                          |
  | `emdash/middleware/redirect`                      | `emdash/internal/middleware/redirect`                      |
  | `emdash/middleware/request-context`               | `emdash/internal/middleware/request-context`               |
  | `emdash/middleware/setup`                         | `emdash/internal/middleware/setup`                         |
  | `emdash/middleware/media-usage-write-fence`       | `emdash/internal/middleware/media-usage-write-fence`       |
  | `emdash/image-endpoint`                           | `emdash/internal/image-endpoint`                           |
  | `emdash/media/local-runtime`                      | `emdash/internal/media/local-runtime`                      |
  | `emdash/object-cache/memory`                      | `emdash/internal/object-cache/memory`                      |
  | `emdash/db/sqlite-migrations`                     | `emdash/internal/db/sqlite-migrations`                     |
  | `emdash/db/libsql-migrations`                     | `emdash/internal/db/libsql-migrations`                     |
  | `emdash/db/postgres-migrations`                   | `emdash/internal/db/postgres-migrations`                   |
  | `emdash/database/migration-lock`                  | `emdash/internal/database/migration-lock`                  |
  | `emdash/database/pg-migration-lock`               | `emdash/internal/database/pg-migration-lock`               |
  | `emdash/plugins/host`                             | `emdash/internal/plugins/host`                             |
  | `emdash/plugins/http-wire`                        | `emdash/internal/plugins/http-wire`                        |
  | `emdash/plugins/adapt-sandbox-entry`              | `emdash/internal/plugins/adapt-sandbox-entry`              |
  | `emdash/plugin-test-runtime`                      | `emdash/internal/plugin-test-runtime`                      |
  | `emdash/testing/registry`                         | `emdash/internal/testing/registry`                         |
  | `@emdash-cms/cloudflare/db/d1-migrations`         | `@emdash-cms/cloudflare/internal/db/d1-migrations`         |
  | `@emdash-cms/cloudflare/db/hyperdrive-migrations` | `@emdash-cms/cloudflare/internal/db/hyperdrive-migrations` |
  
  #### What should I do?
  
  If your project or package imports one of the removed subpaths directly, replace the import with a public entrypoint:
  
  - To configure a database, object cache or media provider, use `sqlite()`, `libsql()` or `postgres()` from `emdash/db`, `memoryCache()` from `emdash/astro`, or `localMedia()` from `emdash/media`, instead of writing their entrypoints by hand.
  - To test a plugin, use `@emdash-cms/plugin-test` instead of `emdash/plugin-test-runtime`.
  - To run your own middleware before EmDash's, set the `middleware.outer` option of `emdash()`. The internal auth, setup, redirect and request-context middleware have no public replacement.
  
  Rebuild after upgrading. `emdash migrate` rejects a migration manifest written by an earlier EmDash version.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `cloudflareCache()` route-cache provider and its `@emdash-cms/cloudflare/cache` and `@emdash-cms/cloudflare/cache/config` entry points. Sites that still import `cloudflareCache` fail to build after upgrading.
  
  Switch to native Workers Caching with the Astro Cloudflare adapter's provider. The adapter enables Workers Cache in the generated deployment configuration when this provider is set:
  
  ```diff title="astro.config.mjs"
  - import { cloudflareCache } from "@emdash-cms/cloudflare";
  + import { cacheCloudflare } from "@astrojs/cloudflare/cache";
  
   export default defineConfig({
   	cache: {
  -		provider: cloudflareCache(),
  +		provider: cacheCloudflare(),
   	},
   });
  ```
  
  Invalidation moves to `cache.purge()` from `cloudflare:workers`, so the `CF_ZONE_ID` and `CF_CACHE_PURGE_TOKEN` secrets are no longer needed and can be deleted. The KV object cache (`kvCache()` and `@emdash-cms/cloudflare/cache/kv`) is unchanged.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a startup warning when an installed or configured plugin declares deprecated capability names such as `read:content`, `network:fetch` or `page:inject`. The warning appears once per plugin and lists each current replacement, for example `read:content → content:read`. The deprecated names keep working throughout 1.x. If a plugin you use triggers the warning, update it, or ask its author to publish a version that uses the current names.
  
  `aiSearch()` from `@emdash-cms/cloudflare` now declares `content:read`, so it no longer triggers the warning.
- Updated dependencies [[`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d), [`f6674fa`](https://github.com/emdash-cms/emdash/commit/f6674fa346964f78ab329fbce1bc4f3b9f0d05ef), [`02c2ad3`](https://github.com/emdash-cms/emdash/commit/02c2ad3b2e6993ca3fbc19fe51086a4cb8c0bb8a), [`bc54886`](https://github.com/emdash-cms/emdash/commit/bc5488685c8a886e2375d066d7424ddf4aac9a78), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd), [`1cdca21`](https://github.com/emdash-cms/emdash/commit/1cdca21510fa10eec6969fa4f83b20e6f9663870), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd)]:
  - emdash@1.0.1

## 1.0.1-rc.1

### Patch Changes

- Updated dependencies [[`f6674fa`](https://github.com/emdash-cms/emdash/commit/f6674fa346964f78ab329fbce1bc4f3b9f0d05ef), [`02c2ad3`](https://github.com/emdash-cms/emdash/commit/02c2ad3b2e6993ca3fbc19fe51086a4cb8c0bb8a), [`1cdca21`](https://github.com/emdash-cms/emdash/commit/1cdca21510fa10eec6969fa4f83b20e6f9663870)]:
  - emdash@1.0.1-rc.1

## 1.0.1-rc.0

### Patch Changes

- [#3515](https://github.com/emdash-cms/emdash/pull/3515) [`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d) Thanks [@ascorbic](https://github.com/ascorbic)! - Releases EmDash 1.0. This release includes breaking changes, such as removing APIs deprecated during 0.x. The other entries for this version describe each one and how to migrate; check them before upgrading from 0.42.
  
  From this release, breaking changes ship only in a new major version.
  
  The first 1.x version is 1.0.1. npm also lists a deprecated `emdash@1.0.0`, published by mistake from 0.7-era code; do not install it.

- [#3518](https://github.com/emdash-cms/emdash/pull/3518) [`bc54886`](https://github.com/emdash-cms/emdash/commit/bc5488685c8a886e2375d066d7424ddf4aac9a78) Thanks [@ascorbic](https://github.com/ascorbic)! - Moves the subpaths that only EmDash itself loads under `emdash/internal/`, and the D1 and Hyperdrive migration executors under `@emdash-cms/cloudflare/internal/`. These paths are not public API: their exports can change or be removed in any release.
  
  Sites that use `emdash()` in `astro.config.mjs` need no changes. The integration, the database, cache and media adapter helpers, and the first-party Cloudflare, workerd sandbox and plugin-test packages all load the new paths automatically.
  
  The following subpaths are removed:
  
  | Removed subpath                                   | Now loaded from                                            |
  | ------------------------------------------------- | ---------------------------------------------------------- |
  | `emdash/routes/*`                                 | `emdash/internal/routes/*`                                 |
  | `emdash/middleware/auth`                          | `emdash/internal/middleware/auth`                          |
  | `emdash/middleware/redirect`                      | `emdash/internal/middleware/redirect`                      |
  | `emdash/middleware/request-context`               | `emdash/internal/middleware/request-context`               |
  | `emdash/middleware/setup`                         | `emdash/internal/middleware/setup`                         |
  | `emdash/middleware/media-usage-write-fence`       | `emdash/internal/middleware/media-usage-write-fence`       |
  | `emdash/image-endpoint`                           | `emdash/internal/image-endpoint`                           |
  | `emdash/media/local-runtime`                      | `emdash/internal/media/local-runtime`                      |
  | `emdash/object-cache/memory`                      | `emdash/internal/object-cache/memory`                      |
  | `emdash/db/sqlite-migrations`                     | `emdash/internal/db/sqlite-migrations`                     |
  | `emdash/db/libsql-migrations`                     | `emdash/internal/db/libsql-migrations`                     |
  | `emdash/db/postgres-migrations`                   | `emdash/internal/db/postgres-migrations`                   |
  | `emdash/database/migration-lock`                  | `emdash/internal/database/migration-lock`                  |
  | `emdash/database/pg-migration-lock`               | `emdash/internal/database/pg-migration-lock`               |
  | `emdash/plugins/host`                             | `emdash/internal/plugins/host`                             |
  | `emdash/plugins/http-wire`                        | `emdash/internal/plugins/http-wire`                        |
  | `emdash/plugins/adapt-sandbox-entry`              | `emdash/internal/plugins/adapt-sandbox-entry`              |
  | `emdash/plugin-test-runtime`                      | `emdash/internal/plugin-test-runtime`                      |
  | `emdash/testing/registry`                         | `emdash/internal/testing/registry`                         |
  | `@emdash-cms/cloudflare/db/d1-migrations`         | `@emdash-cms/cloudflare/internal/db/d1-migrations`         |
  | `@emdash-cms/cloudflare/db/hyperdrive-migrations` | `@emdash-cms/cloudflare/internal/db/hyperdrive-migrations` |
  
  #### What should I do?
  
  If your project or package imports one of the removed subpaths directly, replace the import with a public entrypoint:
  
  - To configure a database, object cache or media provider, use `sqlite()`, `libsql()` or `postgres()` from `emdash/db`, `memoryCache()` from `emdash/astro`, or `localMedia()` from `emdash/media`, instead of writing their entrypoints by hand.
  - To test a plugin, use `@emdash-cms/plugin-test` instead of `emdash/plugin-test-runtime`.
  - To run your own middleware before EmDash's, set the `middleware.outer` option of `emdash()`. The internal auth, setup, redirect and request-context middleware have no public replacement.
  
  Rebuild after upgrading. `emdash migrate` rejects a migration manifest written by an earlier EmDash version.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Removes the deprecated `cloudflareCache()` route-cache provider and its `@emdash-cms/cloudflare/cache` and `@emdash-cms/cloudflare/cache/config` entry points. Sites that still import `cloudflareCache` fail to build after upgrading.
  
  Switch to native Workers Caching with the Astro Cloudflare adapter's provider. The adapter enables Workers Cache in the generated deployment configuration when this provider is set:
  
  ```diff title="astro.config.mjs"
  - import { cloudflareCache } from "@emdash-cms/cloudflare";
  + import { cacheCloudflare } from "@astrojs/cloudflare/cache";
  
   export default defineConfig({
   	cache: {
  -		provider: cloudflareCache(),
  +		provider: cacheCloudflare(),
   	},
   });
  ```
  
  Invalidation moves to `cache.purge()` from `cloudflare:workers`, so the `CF_ZONE_ID` and `CF_CACHE_PURGE_TOKEN` secrets are no longer needed and can be deleted. The KV object cache (`kvCache()` and `@emdash-cms/cloudflare/cache/kv`) is unchanged.

- [#3519](https://github.com/emdash-cms/emdash/pull/3519) [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds a startup warning when an installed or configured plugin declares deprecated capability names such as `read:content`, `network:fetch` or `page:inject`. The warning appears once per plugin and lists each current replacement, for example `read:content → content:read`. The deprecated names keep working throughout 1.x. If a plugin you use triggers the warning, update it, or ask its author to publish a version that uses the current names.
  
  `aiSearch()` from `@emdash-cms/cloudflare` now declares `content:read`, so it no longer triggers the warning.
- Updated dependencies [[`d274172`](https://github.com/emdash-cms/emdash/commit/d27417232e61bf85c1c613fecbe6875e1172af0d), [`bc54886`](https://github.com/emdash-cms/emdash/commit/bc5488685c8a886e2375d066d7424ddf4aac9a78), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd), [`0b4be2c`](https://github.com/emdash-cms/emdash/commit/0b4be2c8388744153a7a82814bfe91af09a1fcfd)]:
  - emdash@1.0.1-rc.0

## 0.42.0

### Minor Changes

- [#3394](https://github.com/emdash-cms/emdash/pull/3394) [`38d200d`](https://github.com/emdash-cms/emdash/commit/38d200d7033149f09725efb53c23534bbb35e811) Thanks [@ttmx](https://github.com/ttmx)! - Adds the `bylines:read` plugin capability, which lets plugins read public byline profiles and the bylines credited on content entries through `ctx.bylines`.
  
  `ctx.bylines` provides `get()` and cursor-paginated `list()` for profiles, plus `getEntriesBylines()` for credits. `getEntriesBylines()` resolves up to 100 entries of one collection in a single call, so a search indexer or feed plugin can attach author names to a page of `ctx.content.list()` results:
  
  ```ts
  const page = await ctx.content.list("posts", { limit: 100 });
  const credits = await ctx.bylines.getEntriesBylines(
  	"posts",
  	page.items.map((entry) => entry.id),
  );
  ```
  
  Credits match what the site renders: the credits assigned in the editor, or the author's linked byline, marked `source: "inferred"`, when an entry has none. They resolve at the entry's own locale. Profiles omit the linked user account, guest flag, and byline custom field values.
  
  The capability is independent of `content:read` and `users:read`. It is available to native plugins and to sandboxed plugins on Cloudflare Worker Loader and Node.js workerd. Installation and update consent list it as a new permission.

### Patch Changes

- [#3335](https://github.com/emdash-cms/emdash/pull/3335) [`0371107`](https://github.com/emdash-cms/emdash/commit/037110704e663ae7b4fe033501d20f14d546f058) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes sandboxed plugins on Cloudflare reporting that media storage is not configured when `ctx.media.readBytes()` reads an R2-backed media item.
- Updated dependencies [[`0371107`](https://github.com/emdash-cms/emdash/commit/037110704e663ae7b4fe033501d20f14d546f058), [`148ff3e`](https://github.com/emdash-cms/emdash/commit/148ff3ee3e7bb86e30e88284bfff54eb286598ed), [`43565ef`](https://github.com/emdash-cms/emdash/commit/43565efe85b19b6bb5ed2e3dead627a34341698d), [`2987a51`](https://github.com/emdash-cms/emdash/commit/2987a514ff8816fff05a25470af0b90829805531), [`03b6b3b`](https://github.com/emdash-cms/emdash/commit/03b6b3b441f624bd4ec376a23ce8789d4bf9e212), [`03b6b3b`](https://github.com/emdash-cms/emdash/commit/03b6b3b441f624bd4ec376a23ce8789d4bf9e212), [`2410395`](https://github.com/emdash-cms/emdash/commit/24103953cc5873f76c36625b11251ac5864dca78), [`2bce20c`](https://github.com/emdash-cms/emdash/commit/2bce20ccc908f921dff3a1904aab870ca7a1a996), [`8b1b585`](https://github.com/emdash-cms/emdash/commit/8b1b585eed4d4a542ee24f449b5992e7aeb72380), [`9f721fb`](https://github.com/emdash-cms/emdash/commit/9f721fb01e0ef7b11311df1f92ac146fb3011f50), [`ff61df9`](https://github.com/emdash-cms/emdash/commit/ff61df9a518d12e57f5e134382413e4acccce3a9), [`ff61df9`](https://github.com/emdash-cms/emdash/commit/ff61df9a518d12e57f5e134382413e4acccce3a9), [`54ef82f`](https://github.com/emdash-cms/emdash/commit/54ef82f084dc5cb207d5b137aabcb68701dcc4be), [`aa054ae`](https://github.com/emdash-cms/emdash/commit/aa054aea7f763fa29378ef80c14d5283a3f9ce57), [`e59d9b4`](https://github.com/emdash-cms/emdash/commit/e59d9b4f5a517a865e6a6482b688919eb83b8b54), [`530dabf`](https://github.com/emdash-cms/emdash/commit/530dabf04b6118ac7639b37ab556015115c16bef), [`c36d974`](https://github.com/emdash-cms/emdash/commit/c36d974101cc5536a500228958412ea07b7aaf44), [`22575b7`](https://github.com/emdash-cms/emdash/commit/22575b760a24e88e40fae91507b1e16eef2c558f), [`09a5bb0`](https://github.com/emdash-cms/emdash/commit/09a5bb07abc5b43c7f39777278800c874f9d27ce), [`7097874`](https://github.com/emdash-cms/emdash/commit/7097874dd8758f2e68d96c3374f6d1a780626230), [`1ee3c4f`](https://github.com/emdash-cms/emdash/commit/1ee3c4f905256afcf44dce192d02de1cd172057b), [`38d200d`](https://github.com/emdash-cms/emdash/commit/38d200d7033149f09725efb53c23534bbb35e811), [`38d200d`](https://github.com/emdash-cms/emdash/commit/38d200d7033149f09725efb53c23534bbb35e811), [`ccf24b4`](https://github.com/emdash-cms/emdash/commit/ccf24b45b7d8d8034d092c0dc293d2d1a99a0cd9), [`0993a3d`](https://github.com/emdash-cms/emdash/commit/0993a3d90ec16ccbcd2a48f2143a235106e3ebfc), [`4d6a87b`](https://github.com/emdash-cms/emdash/commit/4d6a87b6fa4adc1a0c240df28fe8d8accfac2630), [`c23009d`](https://github.com/emdash-cms/emdash/commit/c23009d61d9366d4edd9b1dca8023708ed3b0b0a), [`895fb69`](https://github.com/emdash-cms/emdash/commit/895fb699223f27a26a1556c9d009e71019cece13), [`b869811`](https://github.com/emdash-cms/emdash/commit/b8698118b02b6ee1300f9e80b0cf8164a7b4ee74), [`36a73e3`](https://github.com/emdash-cms/emdash/commit/36a73e3430c3d18f211cc79d8d70024178a81250), [`bb06e3f`](https://github.com/emdash-cms/emdash/commit/bb06e3fb4cf33aa53e669a5980b638e424e38519), [`7a8d368`](https://github.com/emdash-cms/emdash/commit/7a8d368c1ac987786c152316bfa655400a094711), [`9358ede`](https://github.com/emdash-cms/emdash/commit/9358ede608670f3734be4e616f674bdf9a046dfe), [`a3421ef`](https://github.com/emdash-cms/emdash/commit/a3421efde18db29aae068f42b79d712dc93ae2d1), [`c0c0d73`](https://github.com/emdash-cms/emdash/commit/c0c0d73ebfee9915090f2ddacc07a383936410f2), [`f9cc7b4`](https://github.com/emdash-cms/emdash/commit/f9cc7b4e163032a33b4a5d81a3a91a32902cb50e), [`f796444`](https://github.com/emdash-cms/emdash/commit/f79644435efa642ad4bca5d8735efe07cc7aee71), [`d8ea3fc`](https://github.com/emdash-cms/emdash/commit/d8ea3fc6538fe14fdefa553ae771bb2fa583e7ee), [`b2ce32c`](https://github.com/emdash-cms/emdash/commit/b2ce32c31fb448da4a5b0eb2a817982d7613f3e3)]:
  - emdash@0.42.0

## 0.41.0

### Patch Changes

- Updated dependencies [[`35a55a4`](https://github.com/emdash-cms/emdash/commit/35a55a48e5bb5c06f03a2a180f58a6ca3eb6ebad), [`078f167`](https://github.com/emdash-cms/emdash/commit/078f1673456690fe33c7407d8691fa896b296135), [`f6d7c7a`](https://github.com/emdash-cms/emdash/commit/f6d7c7a205e622b7ff444d222765b4252888ab15), [`67ef29d`](https://github.com/emdash-cms/emdash/commit/67ef29d42f82dd567666e9fff6691369162b25e2), [`eee003f`](https://github.com/emdash-cms/emdash/commit/eee003ff2c9e23c01f60b76d28a1cb04485a4e6a), [`a5b4504`](https://github.com/emdash-cms/emdash/commit/a5b450497443ca4b2e236675ab1ba59d15845900), [`73103f3`](https://github.com/emdash-cms/emdash/commit/73103f32b9ad3631ad5edd13fdb1e6469af6082d)]:
  - emdash@0.41.0

## 0.40.1

### Patch Changes

- Updated dependencies [[`8bee2f4`](https://github.com/emdash-cms/emdash/commit/8bee2f4a2618394b6660540ea1d7d2599eccd087), [`bdf62ce`](https://github.com/emdash-cms/emdash/commit/bdf62cebb120aa961bca6129b0d0cabb2f093ebc), [`f9cac8d`](https://github.com/emdash-cms/emdash/commit/f9cac8d494952243a1c67c9a47cbc9f5b523a512), [`190717a`](https://github.com/emdash-cms/emdash/commit/190717a12732c505636e231c3b2c43020d3a3a03), [`cc42ac9`](https://github.com/emdash-cms/emdash/commit/cc42ac94417a44a75aa5618e7b5c2ac2e2066c25), [`7b431fe`](https://github.com/emdash-cms/emdash/commit/7b431fe008c2512249b0d27fc93c9b57638edcf8), [`a59690e`](https://github.com/emdash-cms/emdash/commit/a59690eea91699408994fe574c87f0e555aecc76), [`88253e0`](https://github.com/emdash-cms/emdash/commit/88253e0d6f68131a58316e71eb7550d413464c8a)]:
  - emdash@0.40.1

## 0.40.0

### Minor Changes

- [#3333](https://github.com/emdash-cms/emdash/pull/3333) [`26f2076`](https://github.com/emdash-cms/emdash/commit/26f207686e203dd9f132618ac19ef19afefce020) Thanks [@swissky](https://github.com/swissky)! - Adds optional `cc` and `replyTo` fields to plugin email messages, including from sandboxed plugins:
  
  ```ts
  await ctx.email.send({ to, cc: ["team@example.com"], replyTo: visitorEmail, subject, text });
  ```
  
  `ctx.email.send()` throws when `cc` is not an array of strings or `replyTo` is not a string. `email:beforeSend`, `email:deliver`, and `email:afterSend` hooks receive both fields on `event.message`, and the development console provider prints them. The Cloudflare email provider delivers both, and a message's `replyTo` overrides the provider's configured `replyTo`. Custom `email:deliver` providers should pass `cc` and `replyTo` to their email service.

### Patch Changes

- [#3352](https://github.com/emdash-cms/emdash/pull/3352) [`d177c5e`](https://github.com/emdash-cms/emdash/commit/d177c5e90102189c1784ce7df338acf3de45c101) Thanks [@eisenbruch](https://github.com/eisenbruch)! - Fixes `emdash migrate` on Cloudflare D1 failing with `D1 response is too large` in `079_datetime_normalization`. The REST transport refused any response over 1 MiB, and a batch of fifty revisions with their bodies is several MiB on a site with real content. The default bound is now 64 MiB; `maxResponseBytes` still tightens it.

- [#3151](https://github.com/emdash-cms/emdash/pull/3151) [`08e93b8`](https://github.com/emdash-cms/emdash/commit/08e93b8613e4b4e5fc91ab2cf4a4de3ea7c483ac) Thanks [@emdashbot](https://github.com/apps/emdashbot)! - Fix `cloudflareEmail()` silently failing to reach `binding.send()` on some Astro Cloudflare builds, and make email delivery errors visible in runtime logs.
  
  - The provider now resolves `cloudflare:workers` `env` through a dedicated helper module (`cloudflare-email-env.ts`) so the Worker runtime evaluates it as a static import rather than a direct dynamic import of the built-in specifier. This avoids bundler/runtime paths where `import("cloudflare:workers")` inside the bundled Worker did not resolve.
  - `EmailPipeline.send()` now `console.error`s the provider and recipient before re-throwing a delivery error, so failures are not lost when callers (e.g. magic-link routes) intentionally swallow the error to avoid leaking whether an account exists.
  
  No configuration changes are required; existing `send_email` bindings continue to work.

- [#3346](https://github.com/emdash-cms/emdash/pull/3346) [`1796cd5`](https://github.com/emdash-cms/emdash/commit/1796cd508c2bd6456abe77b458f7d177093df754) Thanks [@ascorbic](https://github.com/ascorbic)! - Updates sandboxed plugin content writes to respect the site transfer write fence. While a site import is writing, or after a failed or cancelled import until it is abandoned, `ctx.content` create, update, and delete calls fail with `503 TRANSFER_IMPORT_IN_PROGRESS`. When the fence cannot be checked, they now fail with `TRANSFER_FENCE_CHECK_FAILED` instead of `MEDIA_USAGE_ACTIVATION_CHECK_FAILED`.

- [#3114](https://github.com/emdash-cms/emdash/pull/3114) [`0327f77`](https://github.com/emdash-cms/emdash/commit/0327f77a21caf0e88a9f0338a9c3ce81bd0d760c) Thanks [@logelog](https://github.com/logelog)! - Fixes `ctx.kv.set()` and storage collection `put()` and `putMany()` writes for sandboxed plugins on Cloudflare. Overwrites retain creation timestamps, and unique constraint failures preserve existing records.
- Updated dependencies [[`f58b8f6`](https://github.com/emdash-cms/emdash/commit/f58b8f64d8f4cde2de9ce3eab0c55654f489ec33), [`5a9d822`](https://github.com/emdash-cms/emdash/commit/5a9d822fa68acb4a48b39ba01f85edf5c61d83d4), [`c99bcd3`](https://github.com/emdash-cms/emdash/commit/c99bcd3e11dd3f20bd0a4c240a8f73378c02de34), [`b8fae35`](https://github.com/emdash-cms/emdash/commit/b8fae350afd7dfcc6dcb668b48cd90791e49bd61), [`678b848`](https://github.com/emdash-cms/emdash/commit/678b848e88b5a5f969c7b46aa8a3471840000921), [`1b1d443`](https://github.com/emdash-cms/emdash/commit/1b1d443b37d0af408ee186ced0ecbec2a3ec2c9d), [`043960e`](https://github.com/emdash-cms/emdash/commit/043960e4dc040b40854c934cc3507b6b3e89b95a), [`f3f7cc3`](https://github.com/emdash-cms/emdash/commit/f3f7cc317348df36bc062be1529a9e80618510b3), [`5eaf095`](https://github.com/emdash-cms/emdash/commit/5eaf0952555d69eb6e618c65bd210fac8c7aaa6d), [`2e8e063`](https://github.com/emdash-cms/emdash/commit/2e8e0639dbd7ee6488337aff82c9a9c615a6050f), [`840a9d3`](https://github.com/emdash-cms/emdash/commit/840a9d363470fed2535665117587f353f8bff698), [`9a5d5b9`](https://github.com/emdash-cms/emdash/commit/9a5d5b97963110468f4719f97af6b52f280b723a), [`08e93b8`](https://github.com/emdash-cms/emdash/commit/08e93b8613e4b4e5fc91ab2cf4a4de3ea7c483ac), [`6f1b046`](https://github.com/emdash-cms/emdash/commit/6f1b046eca49184c8cc3e004375abcb43acb06ec), [`ed51c68`](https://github.com/emdash-cms/emdash/commit/ed51c685bec26ba745624a7c54e9cf96e5e0c927), [`7df822b`](https://github.com/emdash-cms/emdash/commit/7df822ba7cefbe1497518c462b05e57a18df5149), [`21ee693`](https://github.com/emdash-cms/emdash/commit/21ee6930fd0f86f449005bae2ab6ee089705cf02), [`c78a6cb`](https://github.com/emdash-cms/emdash/commit/c78a6cb8c59ad74474e99b5d20f923a3041ac92e), [`ecef5a9`](https://github.com/emdash-cms/emdash/commit/ecef5a9afcc6d75fe92bf014c20e4d1bf6d75084), [`bf6b0a9`](https://github.com/emdash-cms/emdash/commit/bf6b0a9623076a5fbe2368602bca42317f96ad03), [`ad1465d`](https://github.com/emdash-cms/emdash/commit/ad1465d9d4a0e90972b846a4eeb04fb605e1fd1f), [`f832fe9`](https://github.com/emdash-cms/emdash/commit/f832fe9cb66494f2d4c11d9eb748a783909dabcf), [`4a5241a`](https://github.com/emdash-cms/emdash/commit/4a5241aa2a3975855bde5a1f586d10be72729702), [`2db6c98`](https://github.com/emdash-cms/emdash/commit/2db6c989ddb76c3a1d8d99f101d3cbf8c9fbc716), [`e9b70ec`](https://github.com/emdash-cms/emdash/commit/e9b70ec4ead0ca15dc0bcf981e0ca058cd57a5af), [`14e9fdd`](https://github.com/emdash-cms/emdash/commit/14e9fddf13c933e4fc164caf466fe2bb27673dce), [`931b40d`](https://github.com/emdash-cms/emdash/commit/931b40d1e33d7edf8792ff13d1d970e4c14dd515), [`19488ec`](https://github.com/emdash-cms/emdash/commit/19488ecd769a05d85f652f3c4696bc9800b0e471), [`26f2076`](https://github.com/emdash-cms/emdash/commit/26f207686e203dd9f132618ac19ef19afefce020), [`6ebd4ef`](https://github.com/emdash-cms/emdash/commit/6ebd4efee94786fb1524a037b886fa829b0d2e68), [`b2f6c06`](https://github.com/emdash-cms/emdash/commit/b2f6c06a70b8956428a2df7a7186df9231cee279), [`e4b0d81`](https://github.com/emdash-cms/emdash/commit/e4b0d81497a21684f541eaeb32a49dcbb19fce2e), [`baf3010`](https://github.com/emdash-cms/emdash/commit/baf3010c9f9237435110c2514bcde4ea74160139), [`b804977`](https://github.com/emdash-cms/emdash/commit/b804977f39fffc84fff55bb5ba8cb01869e069f5), [`4028ee4`](https://github.com/emdash-cms/emdash/commit/4028ee497554b65ef28d85ac48791ac1b9d18da1), [`90ed23f`](https://github.com/emdash-cms/emdash/commit/90ed23fdd54a7e93cde0d52b3e352726e609a500), [`66f50dd`](https://github.com/emdash-cms/emdash/commit/66f50dda3f7d9b9579134555ef4e71f60453d0c1), [`6f83886`](https://github.com/emdash-cms/emdash/commit/6f83886c10cf603a7550e86f707f37482d2e8165), [`1796cd5`](https://github.com/emdash-cms/emdash/commit/1796cd508c2bd6456abe77b458f7d177093df754), [`3be2921`](https://github.com/emdash-cms/emdash/commit/3be2921875c2d60d9de644c292b5bee0272600d9), [`4a69cc6`](https://github.com/emdash-cms/emdash/commit/4a69cc66cbf50610a9b7e3648d4a61a1af17187a), [`20858ed`](https://github.com/emdash-cms/emdash/commit/20858edbad9d8beabc33c120783e3ed771146d9d), [`d9f0d85`](https://github.com/emdash-cms/emdash/commit/d9f0d851081b528039a011628ead10f61e7d51b2), [`86a33ee`](https://github.com/emdash-cms/emdash/commit/86a33eed10c742692cc9178962f0b7975e4bd23f), [`b5ad2fe`](https://github.com/emdash-cms/emdash/commit/b5ad2fe815139c04ee305a6f346a6f89f4d42f8a), [`ff0ef63`](https://github.com/emdash-cms/emdash/commit/ff0ef632c83f118658d1e3c8a7e32027e9ea2239)]:
  - emdash@0.40.0

## 0.39.1

### Patch Changes

- Updated dependencies [[`2787dab`](https://github.com/emdash-cms/emdash/commit/2787dabad9b88db109cd0a4ff2bd06af050fc81a)]:
  - emdash@0.39.1

## 0.39.0

### Minor Changes

- [#3180](https://github.com/emdash-cms/emdash/pull/3180) [`6e151ef`](https://github.com/emdash-cms/emdash/commit/6e151ef4fbe74581f7c66529e3c3de9ee5ed8953) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds binary-safe `ctx.http.fetch()` behavior to sandboxed plugins on Cloudflare Worker Loader and Node/workerd. Request and response bodies are buffered with an 8 MiB decoded limit, and the returned WHATWG `Response` preserves bytes, status text, headers, final URL, redirect state, and clones across both runners.
  
  Redirected requests follow Fetch method and body rules. The Node/workerd runner also applies the installed version's current network capability and host list immediately after a plugin update.
  
  #### Reading binary responses
  
  Read bytes from the buffered response with the standard Response API:
  
  ```ts
  const response = await ctx.http!.fetch("https://api.example.com/report");
  const bytes = new Uint8Array(await response.arrayBuffer());
  ```
  
  #### Testing external HTTP
  
  `createPluginRuntimeTestHost()` adds `http.respond()`, `http.requests()`, and `http.clear()` for deterministic production-bridge tests:
  
  ```ts
  await host.http.respond("https://api.example.com/report", new Response(new Uint8Array([0, 255])));
  await host.transport.invokeRoute("import-report");
  expect(host.http.requests()).toContainEqual(
  	expect.objectContaining({ url: "https://api.example.com/report" }),
  );
  ```

- [#3171](https://github.com/emdash-cms/emdash/pull/3171) [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated schema, translation, public URL, and content revision discovery for plugins.
  
  Declare `schema:read` to list collection and field definitions through `ctx.schema`. Existing `content:read` access can inspect safe content identity, discover locale siblings with `getTranslations()`, and resolve published routes with `getPublicUrl()`. Public URL resolution follows the site's collection pattern, locale routing, and trailing-slash policy and returns `null` for content without a public route.
  
  Revision snapshots require the separate `content:revisions:read` capability because retained history can contain field values that an administrator removed later. This capability implies ordinary `content:read` access. Installation and plugin updates show both new authorities for consent, and the native, Cloudflare Worker Loader, and Node.js workerd runtimes expose the same methods.

- [#3184](https://github.com/emdash-cms/emdash/pull/3184) [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds capability-gated redirect access for sandboxed plugins. Declare `redirects:read` to list redirect rules with cursor pagination and read a rule with an opaque `_rev`. Declare `redirects:write` to create, update, and delete redirect rules; write access implies read access and installation consent states that the plugin can change where visitors are sent.
  
  Redirect mutations use EmDash's redirect validation and cache invalidation path. Writes are serialized across runtimes so duplicate-source and loop validation use a consistent rule graph. The expanded redirect schema remains compatible with writes from previous host processes during rolling deployments. Loop validation runs when a rule is created or its source or destination changes; enabled-only updates retain the host API's existing behavior. Updates and deletes require the latest `_rev`, reject concurrent changes with `CONFLICT`, and do not let plugins set the host-owned automatic redirect marker. The Cloudflare Worker Loader and Node.js workerd runners expose the same API, and `createPluginRuntimeTestHost()` includes redirect fixtures and inspection for production-boundary tests.

- [#3170](https://github.com/emdash-cms/emdash/pull/3170) [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `comments:read` and `comments:moderate` for sandboxed plugins. `ctx.comments` can get, count, and cursor-page through non-trashed comments, and can change a comment between `approved`, `pending`, and `spam` when the caller supplies the status it previously observed.
  
  `comments:read` exposes comment bodies, author names and email addresses, pseudonymous IP hashes, user agents, and moderation metadata. It does not expose the linked EmDash user-account ID. `comments:moderate` implies that read access, and installation or an update that requests either capability requires operator consent.
  
  Status changes use the core moderation path. A stale expected status rejects with `COMMENT_STATUS_CONFLICT`, and an overlapping transition can reject with `COMMENT_MODERATION_IN_PROGRESS`; a successful transition runs `comment:afterModerate` once with the calling plugin's origin and preserves approval notifications. Hard deletion and bulk status replacement are not included.

- [#3172](https://github.com/emdash-cms/emdash/pull/3172) [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds separate sandboxed-plugin capabilities for reading media bytes and editing media metadata.
  
  Declare `media:bytes:read` to use `ctx.media.readBytes()`. Reads are available only for ready media, default to a 10 MiB limit, enforce the caller's limit while consuming the storage stream, and cannot request more than 16 MiB. The result includes the content hash; ordinary `media:read` metadata excludes content hashes, storage keys, and author identity.
  
  Ready-media metadata URLs use an authenticated media ID route. Authenticated callers with the `media:read` permission can fetch the asset without receiving its storage key; logged-out requests are rejected before the route queries media.
  
  Declare `media:metadata:write` to use `ctx.media.updateMetadata()` for alt text, captions, and focal points. This capability cannot upload, replace, move, or delete media. It does not imply `media:read` or `media:bytes:read`.
  
  `@emdash-cms/plugin-test` also provides binary media fixtures and inspection through the runtime-backed host so plugin tests can exercise the production Worker Loader bridge.

- [#3173](https://github.com/emdash-cms/emdash/pull/3173) [`7aa12b3`](https://github.com/emdash-cms/emdash/commit/7aa12b37adc98ef3b07d6a7132833e72e33c6cc7) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `ctx.settings` for plugin configuration and encrypts fields declared as `type: "secret"` before writing them to the database. Native plugins, Cloudflare Worker Loader plugins, and Node/workerd plugins share the same versioned AES-GCM envelope and plugin-scoped API. `@emdash-cms/plugin-test` can update generated settings through the runtime host and inspect their raw persisted envelope.
  
  Set `EMDASH_ENCRYPTION_KEY` in the runtime process environment before saving secret settings. A standalone Node server does not load `.env` automatically. To rotate the key, place the new key first in a comma-separated list and retain old keys until every plugin secret has been saved again. EmDash does not currently report which key IDs remain in use, so track each resaved credential and verify its integration before removing an old key. Restores need both the database and every encryption key referenced by its stored envelopes.
  
  Cloudflare sites using `nodejs_compat` with a compatibility date before `2025-04-01` must also add `nodejs_compat_populate_process_env` before saving secrets through the generated admin form. Cloudflare enables that behavior by default for later compatibility dates.
  
  Existing plaintext secrets remain readable and are encrypted when saved again. The `ctx.kv.get("settings:<key>")` compatibility alias remains available throughout the EmDash 0.x release line; new plugin code should use `ctx.settings.get("<key>")`.
  
  Only fields declared as `type: "secret"` in `admin.settingsSchema` use this encryption path. Arbitrary plugin KV and state values are unchanged; credentials stored by the bundled AT Protocol and webhook notifier plugins are not migrated by this release.

- [#3194](https://github.com/emdash-cms/emdash/pull/3194) [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds separately consented publication and restore actions to native and sandboxed plugin contexts.
  
  Plugins with `content:publish` can read an entry with an opaque revision and publish, unpublish, schedule, or unschedule it through the same runtime behavior as REST and MCP. Each mutation requires the revision returned by the read or preceding action, and a plugin cannot recursively run the same action for the same entry. The capability implies `content:read` but not `content:write`.
  
  Plugins with `content:restore` can read and restore trashed entries without receiving ordinary content-read or write authority. Restore is revision-fenced and returns the next revision. Existing plugin installations receive neither capability unless a new version declares it and the administrator approves the expanded access.

- [#3185](https://github.com/emdash-cms/emdash/pull/3185) [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `hooks.content-policy:register` for sandboxed and native plugins that need to inspect and reject publication, scheduling, or unpublication without receiving content read, write, or publication-action access.
  
  Policy plugins can register `content:beforePublish`, `content:beforeSchedule`, and `content:beforeUnpublish`. Each event identifies the API, MCP, visual editor, plugin, scheduler, or system origin and includes the authenticated actor when one exists. Return `{ cancel: true, reason }` to reject the action with a stable error code. EmDash validates the reason as 1–500 plain-text characters. For allowed actions, the revision read before policy evaluation becomes the mutation precondition.
  
  Scheduled content runs `content:beforePublish` again when it becomes due. A policy rejection unschedules the entry, lists its public-safe reason and entry link on the dashboard, and avoids retrying the same permanent rejection on every scheduler tick. Successful rescheduling, publication, or deletion clears the record; administrators can dismiss stale records. `@emdash-cms/plugin-test` exposes stored scheduler rejections through `inspect.scheduledPolicyRejections()`.

- [#3190](https://github.com/emdash-cms/emdash/pull/3190) [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds declared request and raw response contracts for sandboxed plugin routes across the native,
  Cloudflare Worker Loader, and Node/workerd runtimes.
  
  Use `methods` to have the host reject other HTTP methods with `405 Method Not Allowed`. Use
  `request.body` with `json`, `text`, `bytes`, `form-data`, or `none` for bounded buffered parsing, and
  list the safe request headers the handler needs. Undeclared routes retain their existing
  method-agnostic JSON and query-string behavior.
  
  Routes with `response: "raw"` return `pluginResponse()` with an unwrapped text or byte body, status,
  and allowlisted representation, download, or redirect headers. Raw responses are limited to 8 MiB.
  The host removes all other plugin-supplied headers, applies the route's cache and browser security
  policy, and rejects active same-origin content types.
  
  `pluginRoute()` infers a sandboxed handler's input from its declared body mode.
  `definePluginRoute()` provides the equivalent inference for trusted native routes.
  `createPluginRuntimeTestHost()` accepts `rawBody` for testing the production request parser with
  text, bytes, URL-encoded data, and multipart form data.

- [#3169](https://github.com/emdash-cms/emdash/pull/3169) [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds the `taxonomies:write` sandboxed-plugin capability for creating taxonomy terms and adding or removing term assignments through `ctx.taxonomies`.
  
  Assignment methods accept term row IDs or translation-group IDs and apply idempotent deltas, so they do not replace existing assignments and concurrent additions are preserved. EmDash validates collection attachment, entry existence, term ownership, configured locales, translation identity, and hierarchy before changing taxonomy state. Sandboxed `createTerm()` rejects `parentId` for a non-hierarchical taxonomy instead of ignoring it. The capability implies `taxonomies:read` and requires renewed consent when an installed plugin first declares it.
  
  Existing REST and MCP term mutations also reject creating or updating a term with a parent in a non-hierarchical taxonomy. Callers that assign parents must mark the taxonomy as hierarchical before creating or reparenting terms.
  
  This release includes migration `082_taxonomy_translation_locale_unique`, which enforces one term per translation group and locale. If an existing database contains duplicate rows, the migration preserves them as independent term groups and copies their assignments before adding the unique index. It can restart safely after any completed statement.
  
  `@emdash-cms/plugin-test` adds taxonomy fixtures and an assignment inspector for production-boundary tests. Taxonomy definition management, assignment replacement, term updates, and term deletion remain unavailable to sandboxed plugins.

### Patch Changes

- [#3272](https://github.com/emdash-cms/emdash/pull/3272) [`fc4a7be`](https://github.com/emdash-cms/emdash/commit/fc4a7be4ca02cc13e270a4cc90259c9cc46187b1) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes revision restore on Cloudflare D1 so the restored content and its audit revision commit atomically. If either write fails, the entry and its revision history remain unchanged.

- [#3164](https://github.com/emdash-cms/emdash/pull/3164) [`6ce67bb`](https://github.com/emdash-cms/emdash/commit/6ce67bb82b744e829c17b0484db3ebfe1229c618) Thanks [@danielmlr](https://github.com/danielmlr)! - Fixes concurrent core migrations on Cloudflare D1 failing partway with errors such as `table "_plugin_storage" already exists`. `emdash migrate` and runtime migrations in `auto` mode take a migration lock in the D1 database. A second run waits up to 10 seconds: it succeeds without applying anything if the first run finishes in that time, and otherwise fails without applying migrations.
  
  A run that stops before releasing the lock leaves it held, because it may have stopped partway through a migration. This happens when a CI job is cancelled during `emdash migrate`, when a Worker in `auto` mode stops during a runtime migration, or when a development server is stopped while it applies migrations. Until the lock is released, pending migrations do not run and a D1 site in `auto` mode fails to initialize EmDash. Once the lock is older than a minute, migration runs fail at once with the lock's time and id, and the runtime retries after its migration-failure backoff.
  
  Adds `emdash migrate --release-lock <id>` to release such a lock. `emdash migrate --status` reports the lock and its id. After confirming that no migration is running, release the lock with that id:
  
  ```sh
  pnpm emdash migrate --release-lock 1788264000000
  ```
  
  Releasing the lock of a remote D1 database needs a build manifest and an API token with D1 Edit permission. A lock in the local D1 database of a development server is released with Wrangler. See [Release a stuck migration lock](https://docs.emdashcms.com/deployment/core-migrations/#release-a-stuck-migration-lock) for both procedures.

- [#3095](https://github.com/emdash-cms/emdash/pull/3095) [`f88db94`](https://github.com/emdash-cms/emdash/commit/f88db94ff26a1a4d09fe4297fb64541d5c1a9b1d) Thanks [@dchaudhari7177](https://github.com/dchaudhari7177)! - Fixes `emdash migrate --d1 <name>` failing for every database name with "Cloudflare D1 database list total_pages is invalid". The D1 list endpoint does not return `total_pages`, so the page count is now derived from `total_count` and `per_page` when it is absent. A preview database whose name only contains the requested name (the `name` filter matches substrings) no longer fails the lookup either.

- [#3244](https://github.com/emdash-cms/emdash/pull/3244) [`5129196`](https://github.com/emdash-cms/emdash/commit/5129196a2b0bbbdfbd47a98f02915f650091f061) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes playground retries reusing a partially initialized database after setup fails, which could make every retry return another 500 error. Trying again now discards the incomplete session and creates a fresh playground database.

- [#3052](https://github.com/emdash-cms/emdash/pull/3052) [`34e9bb5`](https://github.com/emdash-cms/emdash/commit/34e9bb597d947a54c10acdbe84a0f8ebbfdcb505) Thanks [@logelog](https://github.com/logelog)! - Fixes sandboxed `ctx.content.create()` accepting `author_id` and `primary_byline_id` from plugin data on Cloudflare and Workerd. Those values are ignored during creation, and sandboxed reads omit the raw `primary_byline_id` field from `item.data`.

- [#3176](https://github.com/emdash-cms/emdash/pull/3176) [`b11095d`](https://github.com/emdash-cms/emdash/commit/b11095d216d0d352bf4a89745a65aed1d5df1bab) Thanks [@connorblack](https://github.com/connorblack)! - Fixes `cloudflareImages()` and `cloudflareStream()` so their `*EnvVar` options (`accountIdEnvVar`, `accountHashEnvVar`, `apiTokenEnvVar`) read `process.env` on the Node adapter. Previously they only checked Cloudflare Workers bindings, so a Node-hosted site with credentials exported as environment variables failed with a "Missing ..." error even though the variable was set. A Cloudflare Workers binding of the same name still takes precedence when one exists.

- [#3152](https://github.com/emdash-cms/emdash/pull/3152) [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes standard sandboxed plugins so lifecycle, content, media, comment, email, cron, and page metadata hooks run through the same ordered, capability-gated host pipeline as trusted plugins on Cloudflare Workers and Node.js.
  
  Sandbox contexts now expose canonical capabilities, database-backed `ctx.cron`, complete content metadata and filtering, and a real `Response` shape from `ctx.http.fetch()`. Cloudflare response bodies still cross the bridge as text. Admin-managed settings now share the `ctx.kv` settings namespace, lifecycle hooks run once at the correct install/enable boundary, and uninstall cleanup runs before plugin data or bundles are removed.
  
  Plugin builds also preserve hook, route permission and cache, MCP, settings, and field-widget metadata in registry bundles and npm descriptors.

- [#3199](https://github.com/emdash-cms/emdash/pull/3199) [`a487ae3`](https://github.com/emdash-cms/emdash/commit/a487ae3fff62cc37948d64d19e8a808f61ad4d1c) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `emdash/plugins/host` as a narrow runtime entry for platform sandbox adapters. The Cloudflare Worker loads scheduled maintenance and sandbox bridge dependencies when those capabilities first run, reducing startup CPU while preserving existing Worker exports and behavior.

- [#3162](https://github.com/emdash-cms/emdash/pull/3162) [`a4af578`](https://github.com/emdash-cms/emdash/commit/a4af5781360edb83811b38347d6d9bd23a6fc498) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `createPluginRuntimeTestHost()` for sandboxed plugin tests that must exercise EmDash orchestration instead of invoking an isolate directly. The host separates direct transport calls, fixtures, production actions, observable-state inspectors, scheduled time control, cold restart, and disposal.
  
  Runtime actions cover the shipped content lifecycle, plugin activation and deactivation, media upload, public comment submission, comment moderation, plugin-route policy, and scheduled task execution. The controlled scheduler clock applies to cron tasks and scheduled publishing. `restart()` retains D1, plugin storage, media storage, and plugin state while replacing runtime and isolate memory. The host captures delivered email for assertions.
  
  `createPluginTestHost()` and its top-level `invokeHook()` and `invokeRoute()` methods remain compatible for fast transport-level tests. `emdashPluginTest()` supplies the runtime modules required by the documented Vitest configuration. Generated plugin projects continue to use Worker Loader by default and describe Node/workerd parity as an opt-in test for runner-sensitive behavior.

- [#3174](https://github.com/emdash-cms/emdash/pull/3174) [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds structured Block Kit navigation and host-attested administrator locale context for sandboxed plugin pages and dashboard widgets.
  
  Plugins can return `link` elements that target saved content, another page declared by the same plugin, generated plugin settings, or an external HTTP, HTTPS, or `mailto:` URL. EmDash constructs internal admin URLs and opens external links with `noopener noreferrer`. Links never dispatch block actions and cannot appear as form fields.
  
  Block Kit route handlers receive `routeCtx.ui` with the validated surface, administrator locale, and text direction. The host validates every sandboxed page and widget response before rendering it, rejects undeclared plugin-page targets and active URL protocols, and permits external images only over HTTPS to hosts declared in `allowedHosts` under `network:request` consent or under `network:request:unrestricted` consent. Responses are limited to 256 KiB, 20 levels, 2,000 nodes, 1,000 items per array, and 64 KiB per string.
  
  `createPluginRuntimeTestHost()` adds `admin.loadPage()`, `loadWidget()`, `act()`, and `submit()` helpers that exercise the private production route, Worker Loader isolate, host UI context, and response validation.
  
  This is a breaking security tightening for sandboxed plugins that return an external Block Kit image without matching network authority. EmDash rejects the complete page or widget response instead of allowing the administrator's browser to contact an unapproved host.
  
  #### What should I do?
  
  If a plugin returns external Block Kit images, add `network:request` and every image hostname to `allowedHosts`, or add `network:request:unrestricted` when the plugin genuinely requires any hostname. Publish a plugin update so administrators can review and approve the expanded authority. Root-relative images need no manifest change.

- [#3182](https://github.com/emdash-cms/emdash/pull/3182) [`70ab2f8`](https://github.com/emdash-cms/emdash/commit/70ab2f81c101bea441c416caff298820f154889b) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds translation-aware sandboxed plugin content creation through `ctx.content.create(collection, data, { locale, translationOf })`.
  
  The source must be an active entry in the same collection. The new entry joins its translation group, inherits its byline credits and taxonomy assignments, and takes non-translatable field values from the source. Content validation and save hooks run in both the Cloudflare Worker Loader and Node/workerd runners. Save-hook-originated creates do not re-enter save hooks, and the creating plugin's own `content:afterSave` hook is not re-entered.
  
  Each translation group permits one active entry per locale. Duplicate locale creates return `CONFLICT`, missing sources return `NOT_FOUND`, invalid or unconfigured locales return `VALIDATION_ERROR`, and save hooks can return `SAVE_REJECTED`.
- Updated dependencies [[`5510725`](https://github.com/emdash-cms/emdash/commit/551072506d9f37e467b71b0448f6eeda70485f54), [`fc4a7be`](https://github.com/emdash-cms/emdash/commit/fc4a7be4ca02cc13e270a4cc90259c9cc46187b1), [`6e151ef`](https://github.com/emdash-cms/emdash/commit/6e151ef4fbe74581f7c66529e3c3de9ee5ed8953), [`4fef109`](https://github.com/emdash-cms/emdash/commit/4fef1090732a181f718c2398fbf04c05d40cf5f5), [`80ccfaf`](https://github.com/emdash-cms/emdash/commit/80ccfaf198307e7f1760f3406db60f41851a40f2), [`46784e1`](https://github.com/emdash-cms/emdash/commit/46784e10d9bef7f4e3dd3e41c0d78232691d0870), [`f6bf82f`](https://github.com/emdash-cms/emdash/commit/f6bf82fe23a783ac9932f4a913b6873349222899), [`3538bb8`](https://github.com/emdash-cms/emdash/commit/3538bb86c7801edf8634af2656cbe3dd194bca50), [`4ebd2a8`](https://github.com/emdash-cms/emdash/commit/4ebd2a8da46ae144714cef7b776aa6d790f92815), [`dbd77ef`](https://github.com/emdash-cms/emdash/commit/dbd77ef387cf1b0ea22018e442d88450578c8f0c), [`9bffbfa`](https://github.com/emdash-cms/emdash/commit/9bffbfa89797524ff8fbb93919707cb752334a32), [`2818e66`](https://github.com/emdash-cms/emdash/commit/2818e669e1f51f4a3314165eb9b4360b707a67ba), [`6ce67bb`](https://github.com/emdash-cms/emdash/commit/6ce67bb82b744e829c17b0484db3ebfe1229c618), [`9c61f93`](https://github.com/emdash-cms/emdash/commit/9c61f93a67cd297d04439f7ac02d199d817335a2), [`a10f9ca`](https://github.com/emdash-cms/emdash/commit/a10f9ca20d79c1ecfca0584b085bbbbc34144d22), [`ad1dee2`](https://github.com/emdash-cms/emdash/commit/ad1dee288aedda3242a2f456708b53cd2e0b23cd), [`7aa12b3`](https://github.com/emdash-cms/emdash/commit/7aa12b37adc98ef3b07d6a7132833e72e33c6cc7), [`dd885e5`](https://github.com/emdash-cms/emdash/commit/dd885e580c6ed2009a1941bb7fc7166a68b0679c), [`e9c4433`](https://github.com/emdash-cms/emdash/commit/e9c44338794a5f35e016644d8db913bffe6b235d), [`e9c4433`](https://github.com/emdash-cms/emdash/commit/e9c44338794a5f35e016644d8db913bffe6b235d), [`222f329`](https://github.com/emdash-cms/emdash/commit/222f32936ad74e102c1b64d8017625ac913d17dc), [`71901fc`](https://github.com/emdash-cms/emdash/commit/71901fc92b5a09bd5c1321759b2db1aaa9b0e730), [`3cec6f9`](https://github.com/emdash-cms/emdash/commit/3cec6f94bba0293f84488c3dab9d2584e27812f2), [`363dd56`](https://github.com/emdash-cms/emdash/commit/363dd56f2c9027b3c6237c7e5f3346181752cd9a), [`3533d2c`](https://github.com/emdash-cms/emdash/commit/3533d2cd7352bc66ed9b08d84233899b59d9aeaf), [`a6b9884`](https://github.com/emdash-cms/emdash/commit/a6b988430b4788d63441073a75b5878ad6e25aec), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`f0e3817`](https://github.com/emdash-cms/emdash/commit/f0e3817c9b99d7cd53e9a4745f455eedf628d530), [`1e13daa`](https://github.com/emdash-cms/emdash/commit/1e13daa3d0987a57da0a84f87cebda3a0a6461a4), [`27e9450`](https://github.com/emdash-cms/emdash/commit/27e9450352c0d7ef1e1308dc31619491837e561f), [`c029134`](https://github.com/emdash-cms/emdash/commit/c029134b8c9e3fb4d19791c1f5d9450089d12f74), [`1fea699`](https://github.com/emdash-cms/emdash/commit/1fea699007ff3ba31a9f97f9980f75fa0c3e14fc), [`6e151ef`](https://github.com/emdash-cms/emdash/commit/6e151ef4fbe74581f7c66529e3c3de9ee5ed8953), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`a823276`](https://github.com/emdash-cms/emdash/commit/a823276384cdd3fbf60f01fac5ffb22de6e73dba), [`5510725`](https://github.com/emdash-cms/emdash/commit/551072506d9f37e467b71b0448f6eeda70485f54), [`a487ae3`](https://github.com/emdash-cms/emdash/commit/a487ae3fff62cc37948d64d19e8a808f61ad4d1c), [`6daffea`](https://github.com/emdash-cms/emdash/commit/6daffea679d3104fd94781f0cd706756c4da6289), [`71572ba`](https://github.com/emdash-cms/emdash/commit/71572bafdace8051d685e1f4e96c2463eb6eeccb), [`b3433d1`](https://github.com/emdash-cms/emdash/commit/b3433d1e4a9269b16b1c6dfe5536820157ddd119), [`a4af578`](https://github.com/emdash-cms/emdash/commit/a4af5781360edb83811b38347d6d9bd23a6fc498), [`06bad83`](https://github.com/emdash-cms/emdash/commit/06bad83f5f466a32ab52f0c59fab7c2f9a8a76ea), [`a4af578`](https://github.com/emdash-cms/emdash/commit/a4af5781360edb83811b38347d6d9bd23a6fc498), [`808f473`](https://github.com/emdash-cms/emdash/commit/808f473a76141dc048bd527f07749564b445bd12), [`808f473`](https://github.com/emdash-cms/emdash/commit/808f473a76141dc048bd527f07749564b445bd12), [`9ca2de5`](https://github.com/emdash-cms/emdash/commit/9ca2de57b14bebc875fb8c5c124613c14e73f0c9), [`26e035d`](https://github.com/emdash-cms/emdash/commit/26e035d856a1b480dcb964348ae3d367a1a81390), [`dda36bf`](https://github.com/emdash-cms/emdash/commit/dda36bf4fe65c52a52bcc466d20c127caf54ab5f), [`70ab2f8`](https://github.com/emdash-cms/emdash/commit/70ab2f81c101bea441c416caff298820f154889b), [`9e17b18`](https://github.com/emdash-cms/emdash/commit/9e17b183c9aa5b2534f014cb845badf450d8e512), [`8ad06e9`](https://github.com/emdash-cms/emdash/commit/8ad06e9c3317f97a6c8c553b310325c229c0986d), [`7f1a49d`](https://github.com/emdash-cms/emdash/commit/7f1a49d3f670c5e624f0b63ed277b3086bc003e1), [`3030d09`](https://github.com/emdash-cms/emdash/commit/3030d0954dc2e6c3c42283672eaaf15e804043c2), [`93df4e8`](https://github.com/emdash-cms/emdash/commit/93df4e892ba2b737d53ef716755798185db8a142)]:
  - emdash@0.39.0

## 0.38.0

### Minor Changes

- [#3105](https://github.com/emdash-cms/emdash/pull/3105) [`cd3e391`](https://github.com/emdash-cms/emdash/commit/cd3e3913bb9cbb6dc2ca8e7f4b543de62fcc2e29) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes scheduled publishing cache invalidation so newly published content is served after the scheduled task completes.
  
  This release requires stable Astro 6.0.0 or later. Astro 6 prereleases no longer satisfy the package's peer dependency range.
  
  #### What should I do?
  
  Upgrade Astro to version 6.0.0 or later before updating `@emdash-cms/cloudflare` if the site still uses an Astro 6 prerelease.

- [#2980](https://github.com/emdash-cms/emdash/pull/2980) [`570333a`](https://github.com/emdash-cms/emdash/commit/570333ac981e4a152fd5aa1405e443d28a491141) Thanks [@logelog](https://github.com/logelog)! - Adds `getVersioned`, `compareAndSet` and `compareAndDelete` to plugin storage collections and `ctx.kv`. Native and sandboxed plugins can create an absent key or condition a replacement or deletion on the revision they read, preventing concurrent requests from silently overwriting each other.
  
  Pass an explicit `null` revision to create only when absent. A successful replacement returns its new revision; a conflict returns `{ applied: false }`. Invalid input, permission failures and database failures reject the promise. Atomicity applies to one key, so changes spanning multiple records still require an application-level protocol.
  
  Update core and the sandbox adapter together and apply the host database migrations before using the methods. The migration initializes existing records without a backfill. Stored values are preserved, and existing unconditional writes continue to work while invalidating old revisions. Conditional keys are limited to 1,024 JavaScript string characters and values to 1 MiB of UTF-8 JSON.

### Patch Changes

- [#3065](https://github.com/emdash-cms/emdash/pull/3065) [`2b2f69e`](https://github.com/emdash-cms/emdash/commit/2b2f69e89f25afd9abe08d13fd73b3ad0d39ebc1) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes Cloudflare binding failures during runtime startup returning `NOT_CONFIGURED` from EmDash API routes. Missing D1, R2, KV, Durable Object, and Hyperdrive bindings now return `BINDING_NOT_FOUND` with the binding-specific setup message. Invalid KV and Hyperdrive binding configuration returns `CONFIGURATION_ERROR`.

- [#2169](https://github.com/emdash-cms/emdash/pull/2169) [`107c3cc`](https://github.com/emdash-cms/emdash/commit/107c3ccdffece10938ccd995b9b2675f3c54a5d7) Thanks [@vedanshujain](https://github.com/vedanshujain)! - Adds `ctx.storage.<collection>.updateIf(id, { where, set?, delta? })` for atomic conditional updates to existing plugin documents. Use `where` to check stored fields, `set` to replace field values, and `delta` to increment or decrement integer counters. The method returns `{ applied: true, data }` with the updated document, or `{ applied: false }` when the document is absent or the condition fails. It never inserts a document.
  
  Malformed update arguments reject without writing. Deltas require safe integer operands and results; missing or `null` counters start at `0`. Invalid stored counters, overflow, and non-object documents return `{ applied: false }` without changing any fields.
  
  Available to native plugins and sandboxed plugins on Cloudflare and Workerd, with SQLite, D1, and PostgreSQL support. PostgreSQL serialization failures and deadlocks expose `code: "STORAGE_SERIALIZATION_FAILURE"` and `retryable: true`, including across sandbox transports. Retry standalone calls with bounded backoff, or restart the entire explicit transaction.

- [#2351](https://github.com/emdash-cms/emdash/pull/2351) [`f0af9a1`](https://github.com/emdash-cms/emdash/commit/f0af9a10b34ea50a14d04ef3fe84c323b6d17ce2) Thanks [@MattieTK](https://github.com/MattieTK)! - New Cloudflare projects leave the paid-plan Worker Loader binding disabled so they can deploy on the Workers free plan. Enable sandboxed plugins in the scaffold prompt or with `--sandboxed-plugins`.
  
  The Cloudflare `sandbox()` helper now selects the runner from the `LOADER` binding in `wrangler.jsonc`, including the named environment selected with `CLOUDFLARE_ENV`. Without it, config-based sandboxed plugins do not load and marketplace or registry installs return `SANDBOX_NOT_AVAILABLE`, while browsing remains available.

- [#3041](https://github.com/emdash-cms/emdash/pull/3041) [`0ae2f26`](https://github.com/emdash-cms/emdash/commit/0ae2f2652281a90813616c146d75029397435436) Thanks [@danielmlr](https://github.com/danielmlr)! - Adds the cause to the `SANDBOX_NOT_AVAILABLE` error and to the "Plugin sandbox is configured but not available on this platform" startup warning when a configured sandbox runner cannot run plugins. On Cloudflare Workers the message names the missing `worker_loaders` binding or `PluginBridge` export; on Node.js it says that the `workerd` binary did not run.
  
  Sandbox runners report the cause through a new optional `unavailableReason()` method on `SandboxRunner`. Runners without it keep the previous messages.
- Updated dependencies [[`36a021c`](https://github.com/emdash-cms/emdash/commit/36a021c1185073e77da891d54a406ea9ce810826), [`573230f`](https://github.com/emdash-cms/emdash/commit/573230f539e03ea99e6c22f2cd7f704a4abd25d5), [`2b2f69e`](https://github.com/emdash-cms/emdash/commit/2b2f69e89f25afd9abe08d13fd73b3ad0d39ebc1), [`33cb7f0`](https://github.com/emdash-cms/emdash/commit/33cb7f08de03fb7febccc72c9eb29fcf88b9c248), [`befce6d`](https://github.com/emdash-cms/emdash/commit/befce6dcbbedcf2766d6540214a65f3bbb9e745a), [`cd3e391`](https://github.com/emdash-cms/emdash/commit/cd3e3913bb9cbb6dc2ca8e7f4b543de62fcc2e29), [`3f516f4`](https://github.com/emdash-cms/emdash/commit/3f516f4732da476baaf619e930b9ead2826d063c), [`b73a133`](https://github.com/emdash-cms/emdash/commit/b73a1332324fdef1a60cccad56161c75932f7966), [`b1ccecd`](https://github.com/emdash-cms/emdash/commit/b1ccecd5b036522db28365310c1644ad56a5fab3), [`fea6beb`](https://github.com/emdash-cms/emdash/commit/fea6bebfe2d0f26eb7aca45af1a4704e4e7a97bd), [`3bd30da`](https://github.com/emdash-cms/emdash/commit/3bd30da4178f63bafa7aa7147a5cec1d405fa6dd), [`e13fa01`](https://github.com/emdash-cms/emdash/commit/e13fa01118406bba3fc069bb475cb6f13f3bb9ad), [`f9ac286`](https://github.com/emdash-cms/emdash/commit/f9ac286f5a8582809f997aff2999e8a2881c0d74), [`0bcb1d9`](https://github.com/emdash-cms/emdash/commit/0bcb1d9ba13d645009f6624fc08fe2cd3543a127), [`4c89130`](https://github.com/emdash-cms/emdash/commit/4c8913057cdab82c7af66a126722525ee74ba4cb), [`107c3cc`](https://github.com/emdash-cms/emdash/commit/107c3ccdffece10938ccd995b9b2675f3c54a5d7), [`107c3cc`](https://github.com/emdash-cms/emdash/commit/107c3ccdffece10938ccd995b9b2675f3c54a5d7), [`91a4aef`](https://github.com/emdash-cms/emdash/commit/91a4aef76bd2a6c588a22faa44897c7459d81728), [`ef22a2d`](https://github.com/emdash-cms/emdash/commit/ef22a2dc9ffa39844cb7c5caf24eab96e319b07c), [`f0af9a1`](https://github.com/emdash-cms/emdash/commit/f0af9a10b34ea50a14d04ef3fe84c323b6d17ce2), [`dd5ef1a`](https://github.com/emdash-cms/emdash/commit/dd5ef1a23031055e230377480874974dd00d64a2), [`0ae2f26`](https://github.com/emdash-cms/emdash/commit/0ae2f2652281a90813616c146d75029397435436), [`27e432e`](https://github.com/emdash-cms/emdash/commit/27e432e197b592cfe150c9d536cd0696e042a116), [`d409722`](https://github.com/emdash-cms/emdash/commit/d409722ebcb682c767934381a497ccda2b1a068d), [`8b3fd50`](https://github.com/emdash-cms/emdash/commit/8b3fd503d1c8807e785c0696903f5c6d7311dc83), [`1a71c9e`](https://github.com/emdash-cms/emdash/commit/1a71c9e0d88f5e9934fe54329becfa08513d75b9), [`91a4aef`](https://github.com/emdash-cms/emdash/commit/91a4aef76bd2a6c588a22faa44897c7459d81728), [`570333a`](https://github.com/emdash-cms/emdash/commit/570333ac981e4a152fd5aa1405e443d28a491141)]:
  - emdash@0.38.0

## 0.37.0

### Patch Changes

- [#2861](https://github.com/emdash-cms/emdash/pull/2861) [`05d5596`](https://github.com/emdash-cms/emdash/commit/05d559625224fbfd23fc08608c44a46ef3735c3e) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds cropping for JPEG, PNG, and WebP images stored by EmDash on local disk, Cloudflare R2, or S3-compatible storage.

  Move and resize a rule-of-thirds crop frame with corner handles for fixed ratios and eight handles for Freeform. Choose the original ratio, Freeform, or a common aspect ratio. **Create cropped copy** creates a separate media item with any ratio and names it for the selected ratio or output dimensions. **Replace original** uses the original ratio and replaces the existing item under the same ID and URL, so every reference uses the cropped image without rewriting or republishing content. Local media and responsive renditions revalidate their stable URLs so sites load the replacement instead of keeping a stale cached image. The original bytes and crop history are not retained.

- [#2756](https://github.com/emdash-cms/emdash/pull/2756) [`c4286bc`](https://github.com/emdash-cms/emdash/commit/c4286bc5c418396956d9c66c05a52641e6aa7d51) Thanks [@yumam0815](https://github.com/yumam0815)! - Fixes deployment-managed D1 migrations failing on a completely empty database before Kysely can create its migration tables. Migration status now reports empty history without writing, and apply can initialize and run the pending migrations.

- [#2932](https://github.com/emdash-cms/emdash/pull/2932) [`ab26518`](https://github.com/emdash-cms/emdash/commit/ab26518533e7b255196ab9277f907b5a7deabba3) Thanks [@nocdn](https://github.com/nocdn)! - Updates the Playground setup stepper to use slower completion transitions: 900 ms for checkmarks and color changes, 750 ms for connector fills, and a 300 ms handoff to the next step. Progress remains timer-based.

- Updated dependencies [[`76946e4`](https://github.com/emdash-cms/emdash/commit/76946e491c0ceb0317ebe1a1454d9786fc145bff), [`ad19827`](https://github.com/emdash-cms/emdash/commit/ad1982707e0e51bb16fd53f9328a09cb54bb2922), [`cd294dc`](https://github.com/emdash-cms/emdash/commit/cd294dc4fcbafa6fe6a33692d11b9f9abf1cc45c), [`f622a17`](https://github.com/emdash-cms/emdash/commit/f622a1752b0e7e82a33181af2481f57a52ac9b50), [`b06fc63`](https://github.com/emdash-cms/emdash/commit/b06fc6361a88378a697f8d93f7b7718739dc0ed5), [`595a6b1`](https://github.com/emdash-cms/emdash/commit/595a6b12a11e67b89684bc5f5c14fbb6f0fc5e7f), [`ecdba4d`](https://github.com/emdash-cms/emdash/commit/ecdba4d1338447e1a267a3498764f9a1de2a0636), [`7a5d9c1`](https://github.com/emdash-cms/emdash/commit/7a5d9c1838f6afc5649b7bc0940eacf920b40dab), [`de122b4`](https://github.com/emdash-cms/emdash/commit/de122b4e4b65843312bd393d09601e694ef1dee0), [`6676283`](https://github.com/emdash-cms/emdash/commit/6676283a20babf847c5dcc6692296b606d6b6d55), [`05d5596`](https://github.com/emdash-cms/emdash/commit/05d559625224fbfd23fc08608c44a46ef3735c3e), [`d418b64`](https://github.com/emdash-cms/emdash/commit/d418b64ce8cd88a0b67cd089767ed928820f5dc7), [`60691df`](https://github.com/emdash-cms/emdash/commit/60691dfb7c24e362dcd564897bce352268dab658), [`062e8be`](https://github.com/emdash-cms/emdash/commit/062e8be39847581570f579578c3afd584703b22e), [`b44bc2c`](https://github.com/emdash-cms/emdash/commit/b44bc2cc178d204d75d2b4a19c2b28e13ce240f9), [`9def325`](https://github.com/emdash-cms/emdash/commit/9def3252a991f4b750c2d63effd6a474857cd338), [`67f676d`](https://github.com/emdash-cms/emdash/commit/67f676d1e8209d8885532f0f6114bc3686167d34), [`ebd13f8`](https://github.com/emdash-cms/emdash/commit/ebd13f80d7e125f76f4460d851ef83b383ef28d0), [`8a06cd6`](https://github.com/emdash-cms/emdash/commit/8a06cd66b81d153fcc50c4e261364fc5a6b59118), [`6da29d3`](https://github.com/emdash-cms/emdash/commit/6da29d3e3c2d37e83e5bc92c6958fc652f4a9c42), [`4cc3817`](https://github.com/emdash-cms/emdash/commit/4cc3817526733049ee2d2bb198e8c74c94228162), [`d8910d7`](https://github.com/emdash-cms/emdash/commit/d8910d71a775b1b83a45d410171a179c2962fb74), [`b8873c7`](https://github.com/emdash-cms/emdash/commit/b8873c7bd1b1755010bcb46e4511eebccba2b48a), [`01855cb`](https://github.com/emdash-cms/emdash/commit/01855cb9cb8fd748170e462e391925533b226fcd), [`c81e5e7`](https://github.com/emdash-cms/emdash/commit/c81e5e770e070697b4e06b9994d9ea9e8e1fb5f8), [`965bf33`](https://github.com/emdash-cms/emdash/commit/965bf3303bb71a2444c414585e29960606ae0cbb), [`06499ad`](https://github.com/emdash-cms/emdash/commit/06499ad538adcea6f4a580e0c56235851fd239cf), [`bb8b087`](https://github.com/emdash-cms/emdash/commit/bb8b087c9a79c07336d2cdcadc6cec92428a2b4a), [`980538d`](https://github.com/emdash-cms/emdash/commit/980538d22cc73cd2c45263e10234fbaf66067513), [`30d4076`](https://github.com/emdash-cms/emdash/commit/30d40760ee09faec1c77254d76d021f457e507b8), [`9ccc2e7`](https://github.com/emdash-cms/emdash/commit/9ccc2e7277267032459bd9c1fa39d79d645e7ded), [`98ef920`](https://github.com/emdash-cms/emdash/commit/98ef92055bc7d6e1af644bc62ae207651eda3af0), [`556c9fe`](https://github.com/emdash-cms/emdash/commit/556c9fe0eb9c5ea08cb809e0093b007729e1a8e7), [`2970377`](https://github.com/emdash-cms/emdash/commit/29703779c2476bc8f68c317f54b59b4a0744bfe0), [`37e08b0`](https://github.com/emdash-cms/emdash/commit/37e08b013cbd87fe57963a10c31b64091862f975), [`013156d`](https://github.com/emdash-cms/emdash/commit/013156db5bf7e2ce9ba2734eebf85bd2e72c2c36), [`c7b6fdf`](https://github.com/emdash-cms/emdash/commit/c7b6fdfd1f5dd9a168f5d0f6bfa9b7b9ff343145)]:
  - emdash@0.37.0

## 0.36.0

### Minor Changes

- [#2538](https://github.com/emdash-cms/emdash/pull/2538) [`9c52b39`](https://github.com/emdash-cms/emdash/commit/9c52b39fa82f3c13fe9bfbc04d0aa36de4acc219) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Removes scheduled media usage recovery. Media usage tracking now advances only while an administrator keeps its settings page visible. This breaks Cloudflare deployments that configure `mediaUsageCron` and Node.js integrations that provide a custom `CronScheduler`.

  #### What should I do?

  On Cloudflare, remove the dedicated media usage Cron Trigger and the `mediaUsageCron` option. Keep the general Cron Trigger unchanged; no replacement trigger is required.

  If you provide a custom Node.js scheduler, remove `setMediaUsageMaintenance()`. A custom `CronScheduler` now implements only `start()`, `stop()`, `reschedule()`, and `setSystemCleanup()`.

  Keep **Settings → Media usage tracking** open until it shows **Ready**. If the page closes, return to continue from saved progress.

### Patch Changes

- [#2802](https://github.com/emdash-cms/emdash/pull/2802) [`bfdaccd`](https://github.com/emdash-cms/emdash/commit/bfdaccd3fc57027cbe450c393c1de5074c47a631) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Fixes new Playground sessions so the seven demo images appear in the Media Library and remain protected from upload and delete operations.

- [#2759](https://github.com/emdash-cms/emdash/pull/2759) [`fdaff76`](https://github.com/emdash-cms/emdash/commit/fdaff76db1d26dcc46f2035610fbce72271c5c3c) Thanks [@nocdn](https://github.com/nocdn)! - Fixes the Playground setup screen with a left-aligned animated stepper and stable status width, preventing layout shifts before the admin opens.

- [#2802](https://github.com/emdash-cms/emdash/pull/2802) [`bfdaccd`](https://github.com/emdash-cms/emdash/commit/bfdaccd3fc57027cbe450c393c1de5074c47a631) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds `handleMediaUsageActivationAdvance`, `handleMediaUsageProgress`, and `handleMediaUsageRepair` to the `emdash` package root so integrations can activate Media Usage, rebuild usage data, and check when indexing is ready. Playground sessions use these handlers so `Used in` results are ready when the admin opens.

- [#2463](https://github.com/emdash-cms/emdash/pull/2463) [`f613a14`](https://github.com/emdash-cms/emdash/commit/f613a1470581ad750183ba74ba9562d624db8d88) Thanks [@helio-cf](https://github.com/helio-cf)! - Fixes media previews for streaming providers such as Cloudflare Stream. Video from these providers now shows its poster thumbnail in the media library grid and list, plays in the detail panel instead of stalling at 0:00, and reports the file size the provider supplies. Also exports `Media` from `emdash/ui`, so frontends can render provider-backed video and audio that `Image` cannot.

- Updated dependencies [[`3e90689`](https://github.com/emdash-cms/emdash/commit/3e90689102d02e479c0130dcee520c5209530e94), [`1c9fb43`](https://github.com/emdash-cms/emdash/commit/1c9fb43b7230eced28fa212ed09917f6daa2320c), [`9d92b55`](https://github.com/emdash-cms/emdash/commit/9d92b55b0c6b1e8d0506ea11887f18738989c414), [`22c4422`](https://github.com/emdash-cms/emdash/commit/22c442285d648c2226d13c40b807045fcfc2ba74), [`8d8d3de`](https://github.com/emdash-cms/emdash/commit/8d8d3de006ca8652f0ec9e531dd8be7d851e1a4f), [`089d747`](https://github.com/emdash-cms/emdash/commit/089d747dcfde8e27ea805d303e5899805d7b5d70), [`291888a`](https://github.com/emdash-cms/emdash/commit/291888a7d12e3dfa29917cbaf96535bbb4e599ca), [`b383a67`](https://github.com/emdash-cms/emdash/commit/b383a67b5f4a75d5757f76c4385e9ee83df6f3de), [`f6da16b`](https://github.com/emdash-cms/emdash/commit/f6da16b8cea400d1d6dbcb6b9540d0c59004c58f), [`9c52b39`](https://github.com/emdash-cms/emdash/commit/9c52b39fa82f3c13fe9bfbc04d0aa36de4acc219), [`619bb56`](https://github.com/emdash-cms/emdash/commit/619bb56c7d501bb0aa292a61b7d210c437abbf65), [`0f225eb`](https://github.com/emdash-cms/emdash/commit/0f225ebe77559139570cef6231360b60f99be9b5), [`2fde0f9`](https://github.com/emdash-cms/emdash/commit/2fde0f9e5b5d864bcd8006ec243ff2c5f7dde9df), [`37c5010`](https://github.com/emdash-cms/emdash/commit/37c50108aa3489c134f182919cbf78bfa256e520), [`a1ddcfb`](https://github.com/emdash-cms/emdash/commit/a1ddcfb24438ab9af077f795a9dbbe1ba91e1b52), [`d379d10`](https://github.com/emdash-cms/emdash/commit/d379d10f83008748a7479cf959632f3151dc1594), [`b4c73ac`](https://github.com/emdash-cms/emdash/commit/b4c73acd9ba718f55182279dd9c8dd2b6ef2df22), [`436f63d`](https://github.com/emdash-cms/emdash/commit/436f63d7f9f8bf43062ccdbbed76b98307b59149), [`815553c`](https://github.com/emdash-cms/emdash/commit/815553cbcb3f0263116a1dcde3a039fadd867000), [`9c52b39`](https://github.com/emdash-cms/emdash/commit/9c52b39fa82f3c13fe9bfbc04d0aa36de4acc219), [`f527127`](https://github.com/emdash-cms/emdash/commit/f5271270ea32f8c771016d2b4cdf02cb1a0505e2), [`f00174b`](https://github.com/emdash-cms/emdash/commit/f00174b798aa94f31e51dc4b3402f186c25532c7), [`c3c49dd`](https://github.com/emdash-cms/emdash/commit/c3c49dd684ba26be97e0ce1a45c78b6010735ba3), [`f5e18d8`](https://github.com/emdash-cms/emdash/commit/f5e18d8b9f91ba1f758457a8c4765a011dfa70cf), [`bfdaccd`](https://github.com/emdash-cms/emdash/commit/bfdaccd3fc57027cbe450c393c1de5074c47a631), [`9c52b39`](https://github.com/emdash-cms/emdash/commit/9c52b39fa82f3c13fe9bfbc04d0aa36de4acc219), [`628630a`](https://github.com/emdash-cms/emdash/commit/628630acb5bc0b010d7bd317db9d02b70a70d579), [`e3ad082`](https://github.com/emdash-cms/emdash/commit/e3ad0823121704c508cd104783a59fccd3f6a44e), [`abd1042`](https://github.com/emdash-cms/emdash/commit/abd1042ae92ba9c8e9416fed4dc910ecce4802b3), [`f00174b`](https://github.com/emdash-cms/emdash/commit/f00174b798aa94f31e51dc4b3402f186c25532c7), [`f613a14`](https://github.com/emdash-cms/emdash/commit/f613a1470581ad750183ba74ba9562d624db8d88)]:
  - emdash@0.36.0

## 0.35.0

### Minor Changes

- [#2439](https://github.com/emdash-cms/emdash/pull/2439) [`340743b`](https://github.com/emdash-cms/emdash/commit/340743b3e9f7e79f3755fe612901f7ec3fd8efc6) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds deployment-managed D1 migrations through Cloudflare's authenticated REST API.

- [#2439](https://github.com/emdash-cms/emdash/pull/2439) [`340743b`](https://github.com/emdash-cms/emdash/commit/340743b3e9f7e79f3755fe612901f7ec3fd8efc6) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds deployment-managed migrations for PostgreSQL databases reached directly alongside a Hyperdrive deployment.

### Patch Changes

- [#2552](https://github.com/emdash-cms/emdash/pull/2552) [`2c30503`](https://github.com/emdash-cms/emdash/commit/2c305031595934066065e2e20f1c58a76d84d1d8) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes intermittent logged-out bounces immediately after login, signup, or invite acceptance on D1 and Durable Object databases with read replication enabled. The request that establishes the session now persists its read-replica bookmark, so the next request sees the newly created user instead of querying a replica that hasn't caught up yet.

- Updated dependencies [[`0aa1bc8`](https://github.com/emdash-cms/emdash/commit/0aa1bc84a3a652b31ffb15cfd7c2d4b767b83e37), [`34336e1`](https://github.com/emdash-cms/emdash/commit/34336e1570fe2ddaf063b0a0363a9132cf823b8b), [`34336e1`](https://github.com/emdash-cms/emdash/commit/34336e1570fe2ddaf063b0a0363a9132cf823b8b), [`34336e1`](https://github.com/emdash-cms/emdash/commit/34336e1570fe2ddaf063b0a0363a9132cf823b8b), [`2c30503`](https://github.com/emdash-cms/emdash/commit/2c305031595934066065e2e20f1c58a76d84d1d8), [`34336e1`](https://github.com/emdash-cms/emdash/commit/34336e1570fe2ddaf063b0a0363a9132cf823b8b)]:
  - emdash@0.35.0

## 0.34.0

### Minor Changes

- [#1947](https://github.com/emdash-cms/emdash/pull/1947) [`8313255`](https://github.com/emdash-cms/emdash/commit/8313255a60f0e6e85d3dc19143cdd479f1e4c8be) Thanks [@swissky](https://github.com/swissky)! - Adds the authenticated caller to plugin route handlers. Private plugin API routes now receive the requesting user as `ctx.user` (native format) / `routeCtx.user` (standard format) — `{ id, email, name, role, createdAt }` — so plugins can implement per-user logic without trusting a user id from the request body. Public routes and machine tokens with no bound user receive `undefined`.

### Patch Changes

- [#2443](https://github.com/emdash-cms/emdash/pull/2443) [`3ceabc4`](https://github.com/emdash-cms/emdash/commit/3ceabc47467b5fab0c0a83f7beea54b3b6e3e34f) Thanks [@khoinguyenpham04](https://github.com/khoinguyenpham04)! - Adds automatic, resumable background indexing so Media Usage can safely catch up on existing content without processing the whole site at once.

- [#1716](https://github.com/emdash-cms/emdash/pull/1716) [`1d3111c`](https://github.com/emdash-cms/emdash/commit/1d3111cceb2986994cd0c9bc850f5e467d2cdbae) Thanks [@swissky](https://github.com/swissky)! - Fixes every SSR request hanging indefinitely when D1 read replica sessions (`session: "auto"` / `"primary-first"`) are combined with an environment that silently blocks the D1 Sessions API (such as the `global_fetch_strictly_public` compatibility flag). The first session query that never settles now falls back to the direct D1 binding after a short timeout, logs a descriptive error, and disables sessions for the rest of the isolate instead of hanging until the Worker is killed.

- [#2494](https://github.com/emdash-cms/emdash/pull/2494) [`ae87ce8`](https://github.com/emdash-cms/emdash/commit/ae87ce8772926d88ff3cb4f3f7961577571552b2) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes plugin content updates in revision-enabled collections so writes are staged as drafts and preserved when published.

- [#2498](https://github.com/emdash-cms/emdash/pull/2498) [`48806e2`](https://github.com/emdash-cms/emdash/commit/48806e224b0e6a2815905f84144c2fe6cdda1f81) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes plugin-created content to use an explicit or configured default locale instead of always falling back to English.

- Updated dependencies [[`f59f36d`](https://github.com/emdash-cms/emdash/commit/f59f36d5e33e3554af0ddb5e4add3fcc12eb2504), [`a9ace36`](https://github.com/emdash-cms/emdash/commit/a9ace36a0dc697d996b6b0507809d0d2fc39226b), [`70f9ddc`](https://github.com/emdash-cms/emdash/commit/70f9ddcea75063787794dae092a400f093c58807), [`6a77862`](https://github.com/emdash-cms/emdash/commit/6a7786217adee382c92af4cf5e26f3bae6aa0de8), [`3ceabc4`](https://github.com/emdash-cms/emdash/commit/3ceabc47467b5fab0c0a83f7beea54b3b6e3e34f), [`515c08d`](https://github.com/emdash-cms/emdash/commit/515c08d17c1a65e3cf93b27a699956fa4c704e56), [`e28963b`](https://github.com/emdash-cms/emdash/commit/e28963b07c5ffc06e2d4d1660f74b13e9211cf6e), [`d236776`](https://github.com/emdash-cms/emdash/commit/d23677619520442d40cc28e532099aac5efbab5b), [`6602ae0`](https://github.com/emdash-cms/emdash/commit/6602ae05bc23e17642e4dd1179abb6465e20491d), [`6d29cee`](https://github.com/emdash-cms/emdash/commit/6d29ceefdb4adc8a5f2999b5703abd01cea6e27c), [`c9d5ebd`](https://github.com/emdash-cms/emdash/commit/c9d5ebd61e86083e168446f3abfe1dc47b893754), [`5224b57`](https://github.com/emdash-cms/emdash/commit/5224b5711ae36f6302e01abdcba586c615a03b16), [`2d5fb0b`](https://github.com/emdash-cms/emdash/commit/2d5fb0bccdff34de6935d5cd59bca967a8974dc4), [`a159b44`](https://github.com/emdash-cms/emdash/commit/a159b445d42465a3ff0f2e9a9d0b18ec51a34e1d), [`9e74e59`](https://github.com/emdash-cms/emdash/commit/9e74e59958e54ee69ef7ed3ca7bee6f3485c3126), [`f8a4fce`](https://github.com/emdash-cms/emdash/commit/f8a4fcefd297da15658b919a4d91109605e8f7b3), [`5289385`](https://github.com/emdash-cms/emdash/commit/52893854997f8811b729eb22c267dfe8b3ee24ba), [`be283e2`](https://github.com/emdash-cms/emdash/commit/be283e286f2fbd5367d1823b13b6141889f5f9e7), [`3d89f87`](https://github.com/emdash-cms/emdash/commit/3d89f87c449c763a5c99934f3dd90753ab7af660), [`13db62c`](https://github.com/emdash-cms/emdash/commit/13db62c82fbd0fc7b5784e46aa1e03b5c56eeffc), [`cd4268d`](https://github.com/emdash-cms/emdash/commit/cd4268d1d114e827124810a09fe4edc27aa5f784), [`e5cda04`](https://github.com/emdash-cms/emdash/commit/e5cda046608ee83ffbfeda5bd2de0ec8021a3207), [`fefb702`](https://github.com/emdash-cms/emdash/commit/fefb702763f2cbd3921124ef3358e7cac3f9dd64), [`5394ecd`](https://github.com/emdash-cms/emdash/commit/5394ecd0988e941fc1c2c8e97db67a70122c955d), [`49bc75e`](https://github.com/emdash-cms/emdash/commit/49bc75efb134d12a27a5f45d2c78fc63894d48eb), [`8300c64`](https://github.com/emdash-cms/emdash/commit/8300c64e8b6004b8895e0886543c24cd91b05225), [`1c4d4f0`](https://github.com/emdash-cms/emdash/commit/1c4d4f04b2eddae529e802fa08e392939701a977), [`8313255`](https://github.com/emdash-cms/emdash/commit/8313255a60f0e6e85d3dc19143cdd479f1e4c8be), [`4e76317`](https://github.com/emdash-cms/emdash/commit/4e7631797839759ca057c0c9c6fb3cf7f9611a82), [`ed1e79c`](https://github.com/emdash-cms/emdash/commit/ed1e79c0ab21ccdfd35908bd5296280b05932b86), [`7385d43`](https://github.com/emdash-cms/emdash/commit/7385d434caca3faea8752fc454a21f89bc920fca), [`40953d0`](https://github.com/emdash-cms/emdash/commit/40953d0859c4f273b413b110edd74b810eec0cfb), [`ef32567`](https://github.com/emdash-cms/emdash/commit/ef32567fd5e7d9011f5ec9fb630e597cb5846312), [`0cd7c73`](https://github.com/emdash-cms/emdash/commit/0cd7c73b9a945df10e268545c65ec2b620443e94), [`9b99822`](https://github.com/emdash-cms/emdash/commit/9b998224a5305aea15456d101eae023ba1cb191d), [`2398b8d`](https://github.com/emdash-cms/emdash/commit/2398b8d1bde05f3ffb8b4dc5eb01496e1fc60fda), [`d7fe781`](https://github.com/emdash-cms/emdash/commit/d7fe781ed9dd66d0d33ecb9f7c7911da12aa8557), [`598e6fb`](https://github.com/emdash-cms/emdash/commit/598e6fb95f36a1d4c91417e3e3993ba2f5a53129), [`88f29f3`](https://github.com/emdash-cms/emdash/commit/88f29f3bf7566c487c283663973ea1de8308f6a9), [`8008772`](https://github.com/emdash-cms/emdash/commit/8008772849d943eaace66c0c4d051a453078e6f9), [`170c966`](https://github.com/emdash-cms/emdash/commit/170c9669785cdc481fcfba01f744d75c08c248f7), [`4831f77`](https://github.com/emdash-cms/emdash/commit/4831f77454be4bdacc839d7025f4f6021a8d473f), [`5a5adb7`](https://github.com/emdash-cms/emdash/commit/5a5adb79d268bc5305d0c2145aba47489c83a269), [`ae87ce8`](https://github.com/emdash-cms/emdash/commit/ae87ce8772926d88ff3cb4f3f7961577571552b2), [`48806e2`](https://github.com/emdash-cms/emdash/commit/48806e224b0e6a2815905f84144c2fe6cdda1f81), [`144e378`](https://github.com/emdash-cms/emdash/commit/144e3781611a2c7e39bf42b90fdd86435b1a3bdc), [`4c565ea`](https://github.com/emdash-cms/emdash/commit/4c565ea7f99d62f423aa0f61e183f3da37dd8925), [`6d9a0d5`](https://github.com/emdash-cms/emdash/commit/6d9a0d54c0ee04fa286a83cd1e2d54fdc8fa594a), [`5828233`](https://github.com/emdash-cms/emdash/commit/582823328ea2d205c72e25d3456029a4c49e649d), [`5c216c2`](https://github.com/emdash-cms/emdash/commit/5c216c2f9253048e55eef676d3438b0eabbb28a7)]:
  - emdash@0.34.0

## 0.33.0

### Minor Changes

- [#2353](https://github.com/emdash-cms/emdash/pull/2353) [`ea4c39b`](https://github.com/emdash-cms/emdash/commit/ea4c39bb184daf35f98eeb32dc9828bceaff77f0) Thanks [@MA2153](https://github.com/MA2153)! - Adds manual ordering for taxonomy terms. Move terms up and down from the Taxonomies screen, and term listings — `getTerms()` and the terms REST endpoint — return them in that order. The terms attached to a single entry are still listed alphabetically.

  Existing terms keep the order they display in today, now stored explicitly instead of derived from their labels. Terms added afterwards go to the end of their sibling group rather than slotting in alphabetically — if you want a taxonomy alphabetical, order it that way once and it stays.

  A term's position is shared by all of its translations, so ordering a taxonomy in one locale orders it everywhere. On upgrade that means each taxonomy keeps the alphabetical order of the locale its terms were first written in, and other locales are re-sorted to match; reorder once from the Taxonomies screen if you want something different. Sites that need a genuinely different order per language should use separate taxonomies.

  Also fixes moving a term to a new parent only taking effect in the locale you moved it in, which left the term nested in that locale and still at the top level in the others. Moving a term now moves it in every locale, and terms already split this way are repaired on upgrade.

### Patch Changes

- [#2277](https://github.com/emdash-cms/emdash/pull/2277) [`51cbe2e`](https://github.com/emdash-cms/emdash/commit/51cbe2e631c9d03284fa46721e43f92bc576eeb6) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Deprecates `cloudflareCache()` (legacy Cache API + zone REST purge). It now emits a one-time console warning and is marked `@deprecated` in types. New sites should use native Workers Caching (`"cache": { "enabled": true }` in wrangler plus `cacheCloudflare()` from `@astrojs/cloudflare/cache`) and purge with `cache.purge()` — no zone ID or Cache Purge API token.

- [#2280](https://github.com/emdash-cms/emdash/pull/2280) [`f586100`](https://github.com/emdash-cms/emdash/commit/f58610074b4729a77c032913d21125067d56bf26) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes anonymous public pages reseeding edge/object caches with stale Hyperdrive query results right after content publishes. When `cachedBinding` and a distributed Object Cache are configured, public reads across Worker isolates prefer the uncached Hyperdrive binding for a short window after content writes (default 60s, overridable via `preferUncachedAfterWriteMs` to match your Hyperdrive max_age).

- Updated dependencies [[`85dd99d`](https://github.com/emdash-cms/emdash/commit/85dd99d34810261bf25702d2798a9cab2ceeae58), [`e8048e4`](https://github.com/emdash-cms/emdash/commit/e8048e40b41e57bfaf9bf12faedaca5df3dcfe4e), [`534f238`](https://github.com/emdash-cms/emdash/commit/534f23884fa1b79ab78a54a382f9acf381919dc6), [`f6385da`](https://github.com/emdash-cms/emdash/commit/f6385dab2c03ad2da360215c88dac23ff70b9749), [`72660da`](https://github.com/emdash-cms/emdash/commit/72660dabdb4a164f01d152741f89c0b7163c4314), [`969c6cb`](https://github.com/emdash-cms/emdash/commit/969c6cb3a50f0d5a951ea98730e2f8133446f44e), [`0c3af01`](https://github.com/emdash-cms/emdash/commit/0c3af01baf8263ac744486c6ac481cb0791f6eb5), [`640da63`](https://github.com/emdash-cms/emdash/commit/640da63dd06c307cf4d533d63c10da1feadb36f5), [`e7c445c`](https://github.com/emdash-cms/emdash/commit/e7c445ca0ee5bc3970909a1c07d41b14de5d3d79), [`ef78aa1`](https://github.com/emdash-cms/emdash/commit/ef78aa1dca816f1e47067554427ac325e73b22b1), [`0237678`](https://github.com/emdash-cms/emdash/commit/023767805bbcf6e96fc787a02d52413e460d5257), [`741c40c`](https://github.com/emdash-cms/emdash/commit/741c40cad671ece2fe4fabf69b08b0a3467527ed), [`e07f0c8`](https://github.com/emdash-cms/emdash/commit/e07f0c842a086dc0f2a8729f5c07ac8f1584af56), [`425e7c0`](https://github.com/emdash-cms/emdash/commit/425e7c0fee0e0219bae5cf0e4aa7c8e45dbad19f), [`7099d13`](https://github.com/emdash-cms/emdash/commit/7099d13062c9a36ff68aac2e1e4e85998199481d), [`f586100`](https://github.com/emdash-cms/emdash/commit/f58610074b4729a77c032913d21125067d56bf26), [`1dd7f13`](https://github.com/emdash-cms/emdash/commit/1dd7f135a043701effeb164be4f5ae95d106fc78), [`447647d`](https://github.com/emdash-cms/emdash/commit/447647df53098a7c58779f716fd811ffe248271e), [`aec4fa1`](https://github.com/emdash-cms/emdash/commit/aec4fa175a244912e5c1df412d20645ce50365b5), [`ea4c39b`](https://github.com/emdash-cms/emdash/commit/ea4c39bb184daf35f98eeb32dc9828bceaff77f0), [`8040e27`](https://github.com/emdash-cms/emdash/commit/8040e2792f469ce918ac52e73a2487c284be0d98)]:
  - emdash@0.33.0

## 0.32.0

### Minor Changes

- [#633](https://github.com/emdash-cms/emdash/pull/633) [`215f36e`](https://github.com/emdash-cms/emdash/commit/215f36ebbd6d1193c10dd229b789a9a70c8b367e) Thanks [@ttmx](https://github.com/ttmx)! - Adds a Cloudflare AI Search plugin with automatic content indexing, cron-driven reindexing, language-aware queries, synonyms, index status, admin configuration, and an Astro search component with the browser snippet included.

### Patch Changes

- Updated dependencies [[`8d46fd2`](https://github.com/emdash-cms/emdash/commit/8d46fd29506f9164583853909fce8db705b020f3), [`c1f6768`](https://github.com/emdash-cms/emdash/commit/c1f6768adf2ffb4e09c664d684fc3d49e2b885f0), [`ecebade`](https://github.com/emdash-cms/emdash/commit/ecebade8fb3ff4976c88787595fcb2922c3ee469), [`e1ab8f0`](https://github.com/emdash-cms/emdash/commit/e1ab8f08ca262a0b7c981b044cbc52d86f2b7ffe), [`121b333`](https://github.com/emdash-cms/emdash/commit/121b3339b6a2aa1ac86e01bb9ccb5d642af1b620), [`3aabb7b`](https://github.com/emdash-cms/emdash/commit/3aabb7bff8173efabb56ae878a6c2578a7219a10), [`b0c7880`](https://github.com/emdash-cms/emdash/commit/b0c7880c74994e229b4cf4e9a0247452df2bc640), [`4a49262`](https://github.com/emdash-cms/emdash/commit/4a4926267ea625b31975eb22b5c03474e1487eab)]:
  - emdash@0.32.0

## 0.31.1

### Patch Changes

- Updated dependencies [[`f81aa68`](https://github.com/emdash-cms/emdash/commit/f81aa6842c659799eb8952f7f40869b537e340df)]:
  - emdash@0.31.1

## 0.31.0

### Patch Changes

- Updated dependencies [[`15d5a45`](https://github.com/emdash-cms/emdash/commit/15d5a454c4bdde456819b04ef67fcd846f191ead), [`c568876`](https://github.com/emdash-cms/emdash/commit/c568876d78bfcb90d170e03212544a2bda81ddf2), [`f8e41cd`](https://github.com/emdash-cms/emdash/commit/f8e41cdddae07859b1854719fb15536533916f8b), [`c4d790e`](https://github.com/emdash-cms/emdash/commit/c4d790e9025b3fdba53953ec720e5e043fd153ab), [`0eb389f`](https://github.com/emdash-cms/emdash/commit/0eb389f7a297d197e4f537eae44bfdee87e39396), [`791c0eb`](https://github.com/emdash-cms/emdash/commit/791c0eb2836af9fbe3069c75dd1acfb901288592)]:
  - emdash@0.31.0

## 0.30.0

### Minor Changes

- [#2122](https://github.com/emdash-cms/emdash/pull/2122) [`6bbf93a`](https://github.com/emdash-cms/emdash/commit/6bbf93a43969a41648505668becfde60aa10e8dd) Thanks [@bimsonz](https://github.com/bimsonz)! - Expose the host Astro project's `trailingSlash` config to plugins via `ctx.site.trailingSlash`, so plugins that build absolute URLs (sitemaps, canonical, hreflang) can match the site's routing policy. Available to in-process and sandboxed plugins alike.

### Patch Changes

- [#2037](https://github.com/emdash-cms/emdash/pull/2037) [`b66d8a0`](https://github.com/emdash-cms/emdash/commit/b66d8a086ea9fd02acb34d4fb90c54ea155c7120) Thanks [@swissky](https://github.com/swissky)! - Fixes oversized image renditions on Cloudflare: transforms without an explicit quality were encoded near-losslessly by the Images binding (a 2048px WebP came out ~900 KB instead of ~100 KB). Lossy transforms (WebP/AVIF/JPEG) now default to quality 85, matching Cloudflare's image-resizing default. PNG output keeps no explicit quality — an explicit PNG quality switches the binding to lossy PNG8, which is not a safe default for a lossless format. An explicit `?q=` in the request URL still wins for every format.

  Note: image responses are cached with `Cache-Control: immutable, max-age=31536000` keyed on the request URL, so previously-served oversized renditions stay cached at the edge/browser until they expire. To benefit immediately after upgrading, purge the Cloudflare cache for your `/_image*` URLs (or the whole site cache).

- [#2135](https://github.com/emdash-cms/emdash/pull/2135) [`c37750c`](https://github.com/emdash-cms/emdash/commit/c37750c2c57048eaa88dcb785d14940f1307c07e) Thanks [@swissky](https://github.com/swissky)! - Fixes a hang where a request cancelled mid-query on Cloudflare D1 could wedge the query-coalescing buffer: the flush timer scheduled by the cancelled request was dropped with it, leaving the coalescing flag stuck so every later query on the connection waited on a flush that never ran. The coalescing D1 and Durable Object SQL connections now treat a flush left pending past a short deadline as stranded and reschedule it, so a cancelled request can no longer stall subsequent queries.

- [#2125](https://github.com/emdash-cms/emdash/pull/2125) [`ba65fb8`](https://github.com/emdash-cms/emdash/commit/ba65fb83eec5b6bd6d4912cb1feab8b2a4378074) Thanks [@swissky](https://github.com/swissky)! - Fixes a site-wide hang on Cloudflare Workers with the default D1 config (`d1({ binding: "DB" })`, sessions disabled). Previously, a single request canceled while a D1 query was in flight could deadlock every subsequent D1 query on that Worker isolate — including EmDash's own per-request middleware — so all SSR pages hung until the isolate was recycled. Concurrent D1 queries on the default raw binding now run independently instead of being serialized behind a connection mutex, removing the deadlock.

- [#2082](https://github.com/emdash-cms/emdash/pull/2082) [`cf6e4fa`](https://github.com/emdash-cms/emdash/commit/cf6e4fa5d259c24d7ae3038c55039fc56c6c2923) Thanks [@logelog](https://github.com/logelog)! - Fixes production build warnings when database adapters do not provide the optional cold-start query coalescing dialect.

- Updated dependencies [[`82827d3`](https://github.com/emdash-cms/emdash/commit/82827d3f8ffdaa4fae688b89cdcc139aa6c25810), [`fbb04ab`](https://github.com/emdash-cms/emdash/commit/fbb04abcff5b909e28541d3b3e5fca3089870b83), [`07c2b0f`](https://github.com/emdash-cms/emdash/commit/07c2b0f999e35e00153e349f74eb9298669b5fbf), [`460efe6`](https://github.com/emdash-cms/emdash/commit/460efe645baae54ee01b5d42643fc9ac5a926ee1), [`7b9e558`](https://github.com/emdash-cms/emdash/commit/7b9e5589a79435b8cf069528fdbdb4dd9b8988ae), [`aa7ef09`](https://github.com/emdash-cms/emdash/commit/aa7ef096c9ab6628920469fb6a4a75bc9b13395f), [`c180240`](https://github.com/emdash-cms/emdash/commit/c18024003340ad5a03076313057284a0f4eea2be), [`039c5dc`](https://github.com/emdash-cms/emdash/commit/039c5dc6d5ecef03bc8be68616234834abdd20cc), [`b66d8a0`](https://github.com/emdash-cms/emdash/commit/b66d8a086ea9fd02acb34d4fb90c54ea155c7120), [`fc6cdfb`](https://github.com/emdash-cms/emdash/commit/fc6cdfbf2e68c23e916518993b229e38868d1510), [`8d6b20b`](https://github.com/emdash-cms/emdash/commit/8d6b20b18fe0570c491de45f60eddb86c1bc1fe7), [`6bbf93a`](https://github.com/emdash-cms/emdash/commit/6bbf93a43969a41648505668becfde60aa10e8dd), [`1b1ff42`](https://github.com/emdash-cms/emdash/commit/1b1ff42c924056806875ab34f39bbb0bc9e60e74), [`e2c7549`](https://github.com/emdash-cms/emdash/commit/e2c7549d7b98c6cc97ba47ca6de5dd1b532e9c8f), [`6c96ac8`](https://github.com/emdash-cms/emdash/commit/6c96ac8b68d6ba514aba51d5a5282c499afc22d6), [`7ff08db`](https://github.com/emdash-cms/emdash/commit/7ff08dbea6407b566dd5ea7c159510fd871e01b9), [`23a740a`](https://github.com/emdash-cms/emdash/commit/23a740ad3deb248d00f29559e0cc9c7bfa49ec1f), [`6fb52b0`](https://github.com/emdash-cms/emdash/commit/6fb52b08139dead03f61324abe1ed10a9e5552e0), [`a27a5cc`](https://github.com/emdash-cms/emdash/commit/a27a5ccda339cc61df452e025e736addbafd1f9a), [`4c57ee2`](https://github.com/emdash-cms/emdash/commit/4c57ee216f242ef163ae269ec6ff6abfba716e6f), [`e52dea9`](https://github.com/emdash-cms/emdash/commit/e52dea9b72b043d62348f8d01eefade2ce66484c), [`3f8b778`](https://github.com/emdash-cms/emdash/commit/3f8b77822bf8e89b065884c53c7e8b7676788c48), [`de44730`](https://github.com/emdash-cms/emdash/commit/de44730990e8a10b70b0a64ed3747f7038a31eec), [`32be60b`](https://github.com/emdash-cms/emdash/commit/32be60b87f091e24897c78d39b5d15de93946aab), [`d4c565e`](https://github.com/emdash-cms/emdash/commit/d4c565ef99dde5f0a5fafa55b3ca4353dd6d3168), [`b22a3d5`](https://github.com/emdash-cms/emdash/commit/b22a3d5cca0b7217bab3f5fa8c90821fa0eb981c), [`32f8261`](https://github.com/emdash-cms/emdash/commit/32f8261fc028dc6941a14d891a83722c8c830209), [`4b7fd08`](https://github.com/emdash-cms/emdash/commit/4b7fd08468caf7897f9c23a238da27cda8cdf171), [`cf6e4fa`](https://github.com/emdash-cms/emdash/commit/cf6e4fa5d259c24d7ae3038c55039fc56c6c2923), [`d303738`](https://github.com/emdash-cms/emdash/commit/d30373826208bd0182e842d20ca718a78a0585c6), [`6a79b03`](https://github.com/emdash-cms/emdash/commit/6a79b03e6f11c61098f78b81d878604e2ac903e0), [`34b3017`](https://github.com/emdash-cms/emdash/commit/34b30171b1bca29110b64d6ab317e5145150807b), [`6890edd`](https://github.com/emdash-cms/emdash/commit/6890edd3b82b076da43d43685195321e83f50914), [`65be947`](https://github.com/emdash-cms/emdash/commit/65be947258ad22dbd75339e65d1745bb7ebb7c95), [`cfdb8f0`](https://github.com/emdash-cms/emdash/commit/cfdb8f00ea18dc728e6e0fb910cc71d56478ea63), [`ca660c6`](https://github.com/emdash-cms/emdash/commit/ca660c6c9043efe115b851d696a12757d9539f25), [`c4a2ffd`](https://github.com/emdash-cms/emdash/commit/c4a2ffd683a94b2ed015862cd81be9d6e74cdb3d), [`c24b7d3`](https://github.com/emdash-cms/emdash/commit/c24b7d3be5efa95e7874e48360e31fdc8b27a06d), [`84173dd`](https://github.com/emdash-cms/emdash/commit/84173dd64ed67da3035f88f37fc573c9fe9753a5), [`c350e86`](https://github.com/emdash-cms/emdash/commit/c350e86d77b9b6b64963bb3d246daa23979feb4a), [`e649af8`](https://github.com/emdash-cms/emdash/commit/e649af8a7912bf2331341a5d2a4c5a960d27e422)]:
  - emdash@0.30.0

## 0.29.0

### Minor Changes

- [#1719](https://github.com/emdash-cms/emdash/pull/1719) [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260) Thanks [@swissky](https://github.com/swissky)! - Adds a `taxonomies:read` plugin capability with read-only taxonomy access: plugins that declare it get `ctx.taxonomies` to list taxonomy definitions (`getAll()`), fetch the terms of a taxonomy (`getTerms()`), and read the terms assigned to a content entry (`getEntryTerms()`) — in-process and in both sandbox runners.

### Patch Changes

- [#1875](https://github.com/emdash-cms/emdash/pull/1875) [`b116525`](https://github.com/emdash-cms/emdash/commit/b116525425d3687cfe1356704e71ce27832d1db7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes a database stampede on Postgres when a pending migration fails at runtime: requests no longer pile up waiting on the migration lock, failed migrations are retried with a backoff instead of on every request, and failed attempts no longer leak idle database connections.

- Updated dependencies [[`582ea2c`](https://github.com/emdash-cms/emdash/commit/582ea2c6d970ff8f7224c46fbe9cf2b7cc2470ef), [`77e8968`](https://github.com/emdash-cms/emdash/commit/77e8968d906cb4c6cb76c095c7b758a120d6a017), [`e12f393`](https://github.com/emdash-cms/emdash/commit/e12f393fcb70255a5fe74c2ee7ad4f7c23e0bbfd), [`e4e76f5`](https://github.com/emdash-cms/emdash/commit/e4e76f5a5511c5ad42e40b112201d0f426186149), [`0360900`](https://github.com/emdash-cms/emdash/commit/0360900dfa6be62d44d6ce259db1713dae8a4c2e), [`cbc7d6b`](https://github.com/emdash-cms/emdash/commit/cbc7d6b806e993e7a51c47ffa4abb9b31b3d61f5), [`15f4057`](https://github.com/emdash-cms/emdash/commit/15f4057abf0c55a36396d4b8f05e818277b01898), [`1526f96`](https://github.com/emdash-cms/emdash/commit/1526f96c0728ccaf07ecd295170d0ba18e121e8d), [`b116525`](https://github.com/emdash-cms/emdash/commit/b116525425d3687cfe1356704e71ce27832d1db7), [`7c5de08`](https://github.com/emdash-cms/emdash/commit/7c5de08f6370ea88500b7ec425d58b2c82443260), [`450ea81`](https://github.com/emdash-cms/emdash/commit/450ea810aff6b6dfa3797bb99155386189a8a853), [`58f594b`](https://github.com/emdash-cms/emdash/commit/58f594b59641649a445231b56a2dfbdcab434611), [`c57b12b`](https://github.com/emdash-cms/emdash/commit/c57b12ba07ef381e90d132b32aab3ac7b3b3351a), [`9c0733f`](https://github.com/emdash-cms/emdash/commit/9c0733f6f54aa250039a5d0da29b8d8aa9d144cf), [`60811c0`](https://github.com/emdash-cms/emdash/commit/60811c0313096dd485ee9075a0186eb51fc57ca6)]:
  - emdash@0.29.0

## 0.28.1

### Patch Changes

- Updated dependencies [[`b92807f`](https://github.com/emdash-cms/emdash/commit/b92807f02b3c7da9a19a0758a2213c6bda7ddc4c), [`9e4701e`](https://github.com/emdash-cms/emdash/commit/9e4701e89cffd77e98ea10f46731c47e2815b4e6)]:
  - emdash@0.28.1

## 0.28.0

### Patch Changes

- [#1724](https://github.com/emdash-cms/emdash/pull/1724) [`90883de`](https://github.com/emdash-cms/emdash/commit/90883de81eb2da6409d1f176dd2dc8f27c56a547) Thanks [@swissky](https://github.com/swissky)! - Fixes `cloudflareEmail()` failing the Astro build. It now returns a plugin descriptor with a bundlable entrypoint instead of an in-process plugin definition, so the documented `plugins: [cloudflareEmail({...})]` usage builds again.

- Updated dependencies [[`1866fa3`](https://github.com/emdash-cms/emdash/commit/1866fa346e1d4178c60db0fa437b65c0965b1475), [`b36d15c`](https://github.com/emdash-cms/emdash/commit/b36d15c1523dc6e0ada57b4c838f8948b3fbd4fa), [`a3ec23d`](https://github.com/emdash-cms/emdash/commit/a3ec23ddc36889e16a967049de233f21432165a6), [`cdca719`](https://github.com/emdash-cms/emdash/commit/cdca7194b2509993fbb1fc3c39e2e70c8d796ad7), [`ee5bfe6`](https://github.com/emdash-cms/emdash/commit/ee5bfe6b479b736e0432a4d614f5efa01fce02e7), [`a9e9dde`](https://github.com/emdash-cms/emdash/commit/a9e9dde98a9433a1c186490a24865587f1774fd9), [`a9e9dde`](https://github.com/emdash-cms/emdash/commit/a9e9dde98a9433a1c186490a24865587f1774fd9), [`7d16d95`](https://github.com/emdash-cms/emdash/commit/7d16d955003079c8c4a3093decf56bd4f4f05f8a), [`dd05063`](https://github.com/emdash-cms/emdash/commit/dd050637323731fe7795dbc9cf0c3edd906d6908), [`e2dd273`](https://github.com/emdash-cms/emdash/commit/e2dd2738404b7df57ca5e1d50d31b222218d3734), [`92fd412`](https://github.com/emdash-cms/emdash/commit/92fd41227225c425c703e0a0bb62b963c1cd4391), [`932f4ba`](https://github.com/emdash-cms/emdash/commit/932f4ba3adef8be21abc39b4cc7612609895e88c), [`15b4d2d`](https://github.com/emdash-cms/emdash/commit/15b4d2d189142abb69f5c9223c4c1f10363e837f)]:
  - emdash@0.28.0

## 0.27.0

### Minor Changes

- [#1433](https://github.com/emdash-cms/emdash/pull/1433) [`05f4acd`](https://github.com/emdash-cms/emdash/commit/05f4acd0a806f16278492b49d3faffb00c35c93a) Thanks [@swissky](https://github.com/swissky)! - New `cloudflareEmail()` plugin: production email provider via Cloudflare Email Sending

  Deployments on Cloudflare Workers had no production email provider — only the
  dev console stub — so magic-link login, invites and notifications failed with
  "Email is not configured". `cloudflareEmail({ from, replyTo?, binding? })`
  registers the exclusive `email:deliver` hook and delivers through a
  `send_email` Worker binding. Add it to the emdash() plugins array, activate it
  under Extensions, then select it under Settings → Email.

### Patch Changes

- [#1715](https://github.com/emdash-cms/emdash/pull/1715) [`b093193`](https://github.com/emdash-cms/emdash/commit/b09319301c1113be7667bb06b0dcde5b968d3b1a) Thanks [@swissky](https://github.com/swissky)! - Documents that D1 read replica sessions (`session: "auto"` / `"primary-first"`) are incompatible with the `global_fetch_strictly_public` compatibility flag, which silently blocks the D1 Sessions API and hangs every SSR request without logging an error.

- Updated dependencies [[`7422460`](https://github.com/emdash-cms/emdash/commit/7422460adf85863abfc27e8f83ba0cb40a3e942a), [`e4eab4f`](https://github.com/emdash-cms/emdash/commit/e4eab4fba69f1cf249db192938d397aa1b116015), [`46ef945`](https://github.com/emdash-cms/emdash/commit/46ef945d5fcffeef4ac9aecd2fb63fcb49c24b65), [`cff8498`](https://github.com/emdash-cms/emdash/commit/cff84987c679faa61bf491c630b3f77d0083ca21), [`dea8210`](https://github.com/emdash-cms/emdash/commit/dea82106602bb6dde0edd8c007a5acfa5fd7600d), [`90ffe40`](https://github.com/emdash-cms/emdash/commit/90ffe40a1a31193b2f29ef92202e4f339a2487fa), [`386faf5`](https://github.com/emdash-cms/emdash/commit/386faf5bd724ce0b47240e9176c92f554fd66c00), [`2a7063a`](https://github.com/emdash-cms/emdash/commit/2a7063a4e44a7ebb770f1cb28acb5bffac15fca2)]:
  - emdash@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [[`facdcfc`](https://github.com/emdash-cms/emdash/commit/facdcfc745059a6f183581963fcc29c8b6efec63), [`f44a277`](https://github.com/emdash-cms/emdash/commit/f44a2775c8e87be1398befcb29da6bec28bad01c), [`971c627`](https://github.com/emdash-cms/emdash/commit/971c6271e810a8e12e63303778a132a48eb75f4a), [`e5b95e1`](https://github.com/emdash-cms/emdash/commit/e5b95e195e1307237db9eb26806c54c76cc0f81d), [`13b87b7`](https://github.com/emdash-cms/emdash/commit/13b87b70296443db14bf163cd3b25ff2a5701227), [`8f7604d`](https://github.com/emdash-cms/emdash/commit/8f7604dfd8f274b7a62bcbccd53068930b304777), [`5dea403`](https://github.com/emdash-cms/emdash/commit/5dea4035ec2f15fa2248e1621386a91320d50f6d), [`3d80be5`](https://github.com/emdash-cms/emdash/commit/3d80be5e0f1e91844bcf138dea8e86861bc484b4), [`d1116ae`](https://github.com/emdash-cms/emdash/commit/d1116ae6d02f5c15ea5efb68cce78bb24f13ccb6), [`192741f`](https://github.com/emdash-cms/emdash/commit/192741f9a34ede62e23c3de63e3b2483f0b948b6), [`737da19`](https://github.com/emdash-cms/emdash/commit/737da19f56998a5e7f77eecf9337d5f29a18cea6), [`5299d38`](https://github.com/emdash-cms/emdash/commit/5299d38d9c7e92b9faafbe24820164517fc2360c)]:
  - emdash@0.26.0

## 0.25.1

### Patch Changes

- Updated dependencies [[`d4237eb`](https://github.com/emdash-cms/emdash/commit/d4237ebb875321b2b160034f03321a57f366c495), [`2216dca`](https://github.com/emdash-cms/emdash/commit/2216dcab39d7c0034af81be3543c8440a10d8961)]:
  - emdash@0.25.1

## 0.25.0

### Minor Changes

- [#1662](https://github.com/emdash-cms/emdash/pull/1662) [`942fac6`](https://github.com/emdash-cms/emdash/commit/942fac6c87d7a6ce3a62ec7e0610887db5a44f3f) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Adds an optional `cachedBinding` to the `hyperdrive()` adapter for serving anonymous public-site reads from a caching-enabled Hyperdrive configuration. When set, anonymous reads of public paths route through the cache-enabled binding, while every authenticated request, every write, and every request under `/_emdash` (admin, setup, auth, internal APIs) stays on the primary (caching-disabled) `binding` — preserving read-after-write consistency, including for the anonymous post-setup status check. Bind both Hyperdrive configurations in wrangler and pass `hyperdrive({ binding: "HYPERDRIVE", cachedBinding: "HYPERDRIVE_CACHED" })`. Omitting `cachedBinding` leaves behavior unchanged.

### Patch Changes

- Updated dependencies [[`942fac6`](https://github.com/emdash-cms/emdash/commit/942fac6c87d7a6ce3a62ec7e0610887db5a44f3f), [`1f4aa59`](https://github.com/emdash-cms/emdash/commit/1f4aa59a284bb6fa10dd9672a671b62a2a1ba3aa), [`38a63d5`](https://github.com/emdash-cms/emdash/commit/38a63d54e7c7c2735caa179b303c63c175a9570e), [`0f8d1ff`](https://github.com/emdash-cms/emdash/commit/0f8d1ffc081e31217eadc0d71051d7c7324ca173)]:
  - emdash@0.25.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`489a4d1`](https://github.com/emdash-cms/emdash/commit/489a4d130fea2fdc231aae93d6d2966601b51ceb), [`489a4d1`](https://github.com/emdash-cms/emdash/commit/489a4d130fea2fdc231aae93d6d2966601b51ceb)]:
  - emdash@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [[`79fc8b5`](https://github.com/emdash-cms/emdash/commit/79fc8b5b16b07001f5c0a4d964c2ac1fabd39573), [`e659a5c`](https://github.com/emdash-cms/emdash/commit/e659a5c25001ec181c8771e17a8c3264d1498fbf), [`d8487f9`](https://github.com/emdash-cms/emdash/commit/d8487f99ba05b9b96e3a200d8b1f0e1902c4ac8c)]:
  - emdash@0.24.0
