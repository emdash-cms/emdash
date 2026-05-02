# @emdash-cms/admin

## 0.9.0

### Minor Changes

- [#731](https://github.com/emdash-cms/emdash/pull/731) [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea) Thanks [@drudge](https://github.com/drudge)! - Adds a `media_picker` Block Kit element: a thumbnail preview with a modal library picker and mime-type filter. Usable in plugin block forms and in Block Kit field widgets. The stored value is the selected asset's URL string, so it is value-compatible with a plain `text_input` — existing content continues to work after swapping. The `mime_type_filter` is restricted to image MIME types (`image/` or `image/<subtype>`); wildcards and non-image types are rejected.

- [#809](https://github.com/emdash-cms/emdash/pull/809) [`e7df21f`](https://github.com/emdash-cms/emdash/commit/e7df21f0adca795cdb233d6e64cd543ead7e2347) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds an optional `category` field to `PortableTextBlockConfig` for plugin-contributed block types. Plugins can now choose how their blocks are grouped in the admin slash menu (e.g. "Sections", "Marketing", "Media", "Layout") instead of always falling under "Embeds". Existing plugins that omit the field continue to render under "Embeds" exactly as before.

- [#814](https://github.com/emdash-cms/emdash/pull/814) [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19) Thanks [@arashackdev](https://github.com/arashackdev)! - rtl srtyle improvements and LTR/RTL compatible arrow/caret icons

- [#854](https://github.com/emdash-cms/emdash/pull/854) [`491aeec`](https://github.com/emdash-cms/emdash/commit/491aeec5a66e2f764eb9d8ed8425e9d402ada4a7) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Adds consistently-placed sticky Save buttons across editor pages so unsaved changes are always visible. The Content editor, Section editor, Content Type editor, and Settings sub-pages (General, SEO, Social Links) now render their primary save action in a sticky top-right header that stays visible while users scroll long forms. The existing bottom-of-form save buttons are preserved so keyboard and screen-reader users still hit a save action as the last interactive control on the page (DOM order is unchanged). Introduces a shared `EditorHeader` component for editor pages that want the same sticky-header pattern. Fixes #233.

### Patch Changes

- [#849](https://github.com/emdash-cms/emdash/pull/849) [`d6754ae`](https://github.com/emdash-cms/emdash/commit/d6754ae7746b0f9035d2c5e390ece7199762b094) Thanks [@drudge](https://github.com/drudge)! - Fixes the `datetime` field widget so existing values display in the editor and new values pass server validation. The widget passed raw ISO 8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`) into `<input type="datetime-local">`, which silently rendered empty, and emitted `YYYY-MM-DDTHH:mm` on save, which the field's zod schema rejected. Strips the suffix for display, appends `:00.000Z` on save, and normalizes date-only stored values to UTC midnight for the input. Applies to the top-level `datetime` widget in the content editor and the `datetime` sub-field type inside `RepeaterField`.

- [#702](https://github.com/emdash-cms/emdash/pull/702) [`0ee372a`](https://github.com/emdash-cms/emdash/commit/0ee372a7f33eecce7d90e12624923d2d9c132adf) Thanks [@ilicfilip](https://github.com/ilicfilip)! - Adds `@emdash-cms/plugin-field-kit` — composable field widgets for `json` fields. Four widgets (`object-form`, `list`, `grid`, `tags`) are configured entirely through seed `options` so site builders don't need to write React to get a usable editing UI. Widgets store clean JSON (no nesting, no mutation of shape), so removing the plugin leaves valid data in the database. See discussion #571 for background.

  Widens `FieldDescriptor.options` to `Array<{ value: string; label: string }> | Record<string, unknown>` so plugin widgets can accept arbitrary widget config (not only enum choices). The array shape for `select` / `multiSelect` continues to work unchanged.

- [#856](https://github.com/emdash-cms/emdash/pull/856) [`ef3f076`](https://github.com/emdash-cms/emdash/commit/ef3f076c8112e9dffc2a87c019e5521e823f5e86) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes `npm install` peer dependency conflicts (#819) by removing `react` and `react-dom` from `dependencies`. They were declared in both `dependencies` and `peerDependencies`, which made npm think the admin package required an exact pinned React version and conflicted with the host Astro app's React. They remain `peerDependencies` (`^18.0.0 || ^19.0.0`), and the host app supplies React.

- [#821](https://github.com/emdash-cms/emdash/pull/821) [`8d0feb3`](https://github.com/emdash-cms/emdash/commit/8d0feb3eece62b01075260bbb79188984a8631b8) Thanks [@r2sake](https://github.com/r2sake)! - Fixes the Settings (gear) icon on the Plugin Manager so it links to the plugin's primary admin page instead of a non-existent `/settings` sub-route.

- [#862](https://github.com/emdash-cms/emdash/pull/862) [`8354088`](https://github.com/emdash-cms/emdash/commit/83540887936a87a6c99230b21d2afe3fe424218c) Thanks [@ask-bonk](https://github.com/apps/ask-bonk)! - Fixes slug-style `<input pattern="...">` attributes so HTML form validation works in current browsers. The patterns used `[a-z0-9-]+`, which is rejected as `Invalid character class` when compiled with the `v` (unicode-sets) flag — the mode browsers now use for the `pattern` attribute. The dangling `-` is now escaped (`[a-z0-9\-]+`), restoring slug validation in the Sections list/edit, Menus list, and Widgets create-area dialogs. Resolves #845.

- [#887](https://github.com/emdash-cms/emdash/pull/887) [`254a443`](https://github.com/emdash-cms/emdash/commit/254a443684ec3bddfc2706b349d6ccce901987af) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes stale content shown in the Portable Text editor when switching between translations of the same content. Previously, navigating from one locale's editor to another (e.g. from the English version of a post to the French version) kept the previous locale's body in the editor, and any subsequent edit would silently overwrite the new translation's content. The form now resets synchronously when the underlying content item changes, and field editors are keyed by item id so they remount cleanly on a translation switch.

- [#885](https://github.com/emdash-cms/emdash/pull/885) [`25128b2`](https://github.com/emdash-cms/emdash/commit/25128b2444853e3301af7ff09d21a3f5883a599f) Thanks [@ahliweb](https://github.com/ahliweb)! - Fixes malformed ICU plural syntax in Indonesian (id) locale — ContentList item count now renders correctly

- [#872](https://github.com/emdash-cms/emdash/pull/872) [`ab45916`](https://github.com/emdash-cms/emdash/commit/ab45916e8561678ccddf7d6184a7d56729ea03cc) Thanks [@ahliweb](https://github.com/ahliweb)! - Enables Indonesian (Bahasa Indonesia) locale in the admin UI

- [#807](https://github.com/emdash-cms/emdash/pull/807) [`0913a39`](https://github.com/emdash-cms/emdash/commit/0913a39a23538c96bfa62fe7da37bf332d18bb46) Thanks [@ascorbic](https://github.com/ascorbic)! - Sizes the plugin block edit modal based on field complexity so Block Kit forms have room to breathe. Simple URL embeds keep the previous compact dialog; forms with several fields get a wider one, and forms containing a repeater open at the largest size. Inputs inside the dialog now fill the available width.

- [#815](https://github.com/emdash-cms/emdash/pull/815) [`ddbf808`](https://github.com/emdash-cms/emdash/commit/ddbf8088e1bcfa07d6347a953bb1995295e8f8fd) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes content list loading state showing `No results for ""` instead of a loader while items are being fetched. The trash tab gets the same treatment.

- [#870](https://github.com/emdash-cms/emdash/pull/870) [`1c958fb`](https://github.com/emdash-cms/emdash/commit/1c958fb484387cd8cce7fab53ff4eddfe0dbb7f6) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes the image-settings icon in the Section editor so it actually opens `<ImageDetailPanel>` in the sidebar.

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

- Updated dependencies [[`7b8d496`](https://github.com/emdash-cms/emdash/commit/7b8d4964c619821937d1a738cbd6f81e98095a91), [`9dfc65c`](https://github.com/emdash-cms/emdash/commit/9dfc65c42c04c41088e0c8f5a8ca4347643e2fea), [`a838000`](https://github.com/emdash-cms/emdash/commit/a83800068678daf6391e02bba8acf27ff4db0e19)]:
  - @emdash-cms/blocks@0.9.0

## 0.8.0

### Minor Changes

- [#679](https://github.com/emdash-cms/emdash/pull/679) [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d) Thanks [@drudge](https://github.com/drudge)! - Adds a `repeater` Block Kit element: array-of-objects with scalar sub-fields, drag-to-reorder, and collapsible item cards. Plugin block forms can now capture repeating data (FAQ rows, carousel slides, card grids) inline in the portable-text editor.

- [#779](https://github.com/emdash-cms/emdash/pull/779) [`e402890`](https://github.com/emdash-cms/emdash/commit/e402890fcd8647fdfe847bb34aa9f9e7094473dd) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `settings_get` and `settings_update` MCP tools so agents can read and update site-wide settings (title, tagline, logo, favicon, URL, posts-per-page, date format, timezone, social, SEO). `settings_get` resolves media references (logo/favicon/seo.defaultOgImage) to URLs; `settings_update` is a partial update that preserves omitted fields. New `settings:read` (EDITOR+) and `settings:manage` (ADMIN) API token scopes back the tools, with matching options in the personal API token settings UI.

- [#398](https://github.com/emdash-cms/emdash/pull/398) [`31333dc`](https://github.com/emdash-cms/emdash/commit/31333dc593e2b9128113e4e923455209f11853fd) Thanks [@simnaut](https://github.com/simnaut)! - Adds pluggable auth provider system with AT Protocol as the first plugin-based provider. Refactors GitHub and Google OAuth from hardcoded buttons into the same `AuthProviderDescriptor` interface. All auth methods (passkey, AT Protocol, GitHub, Google) are equal options on the login page and setup wizard.

### Patch Changes

- [#611](https://github.com/emdash-cms/emdash/pull/611) [`86b26f6`](https://github.com/emdash-cms/emdash/commit/86b26f6c1067efb28d8f7cb447be23da99d2e38e) Thanks [@drudge](https://github.com/drudge)! - Wires up the block configuration sidebar inside `WidgetEditor`. `PortableTextEditor` now receives `onBlockSidebarOpen`/`onBlockSidebarClose` callbacks that hold the active `BlockSidebarPanel` in local state, and renders `ImageDetailPanel` when the panel type is `"image"` — mirroring the content-entry editor. Without this, clicking a block's settings button or the media picker inside widget content had no visible effect.

- [#786](https://github.com/emdash-cms/emdash/pull/786) [`e998083`](https://github.com/emdash-cms/emdash/commit/e998083115b3c5a6e27707a940dfac557ea72458) Thanks [@smart-cau](https://github.com/smart-cau)! - Adds Korean translations for 21 admin UI strings that previously fell back to English. Korean (ko) coverage is now complete.

- [#670](https://github.com/emdash-cms/emdash/pull/670) [`37ada52`](https://github.com/emdash-cms/emdash/commit/37ada52a62e94f4f0581f4356ba55dc978863f49) Thanks [@segmentationfaulter](https://github.com/segmentationfaulter)! - Change text direction of input fields and tiptap editor depending upon the language entered

- [#720](https://github.com/emdash-cms/emdash/pull/720) [`acab807`](https://github.com/emdash-cms/emdash/commit/acab8071e72a29751a55e923473cd4749e34fefd) Thanks [@Pouf5](https://github.com/Pouf5)! - Fix taxonomies not nesting correctly in a RTL layout

- [#750](https://github.com/emdash-cms/emdash/pull/750) [`0ecd3b4`](https://github.com/emdash-cms/emdash/commit/0ecd3b4901eb721825b36eb4812506032e43da14) Thanks [@edrpls](https://github.com/edrpls)! - Make the admin collection list column headers sortable. `Title`, `Status`, `Locale`, and `Date` are now clickable buttons that toggle direction; the current sort state is exposed via `aria-sort` on the `<th>` so screen readers announce it correctly.

  The server's `orderBy` field whitelist now accepts `status`, `locale`, and `name` alongside the existing date fields — unchanged from a security standpoint, the repo still rejects unknown field names to prevent column enumeration.

  Callers of `<ContentList>` that don't pass `onSortChange` render the previous static-label headers, so legacy integrations (e.g. the content picker) are unaffected.

- [#184](https://github.com/emdash-cms/emdash/pull/184) [`4c9f04d`](https://github.com/emdash-cms/emdash/commit/4c9f04d9506a9a79cec2425ccb71785a6948843a) Thanks [@masonjames](https://github.com/masonjames)! - Fixes plugin block defaults so initial values are seeded without overriding later edits.

- [#700](https://github.com/emdash-cms/emdash/pull/700) [`ed4d880`](https://github.com/emdash-cms/emdash/commit/ed4d88057e9b26d497181655eecf3e06e12a1001) Thanks [@dcardosods](https://github.com/dcardosods)! - Prefill site title and tagline in Setup Wizard from seed file

- Updated dependencies [[`6e0e921`](https://github.com/emdash-cms/emdash/commit/6e0e9215e00f6f2e84ade30447e4c30b1812dbf5), [`493e317`](https://github.com/emdash-cms/emdash/commit/493e3172d4539d8e041e6d2bf2d7d2dc89b2a10d)]:
  - @emdash-cms/blocks@1.0.0

## 0.7.0

### Minor Changes

- [#705](https://github.com/emdash-cms/emdash/pull/705) [`8ebdf1a`](https://github.com/emdash-cms/emdash/commit/8ebdf1af65764cc4b72624e7758c4a666817aade) Thanks [@eba8](https://github.com/eba8)! - Adds admin white-labeling support via `admin` config in `astro.config.mjs`. Agencies can set a custom logo, site name, and favicon for the admin panel, separate from public site settings.

### Patch Changes

- [#680](https://github.com/emdash-cms/emdash/pull/680) [`2e4b205`](https://github.com/emdash-cms/emdash/commit/2e4b205b1df30bdb6bb96259f223b85610de5e78) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes dark mode toggle having no effect with the classic theme.

- [#732](https://github.com/emdash-cms/emdash/pull/732) [`e3e18aa`](https://github.com/emdash-cms/emdash/commit/e3e18aae92d31cf22efd11a0ba06110de24a076a) Thanks [@jcheese1](https://github.com/jcheese1)! - Fixes select dropdown appearing behind dialog by removing explicit z-index values and adding `isolate` to the admin body for proper stacking context.

- [#647](https://github.com/emdash-cms/emdash/pull/647) [`743b080`](https://github.com/emdash-cms/emdash/commit/743b0807f1a37fdedbcd37632058b557f493f3be) Thanks [@arashackdev](https://github.com/arashackdev)! - Adds Persian (Farsi) locale with full admin translations.
  Adds Vazirmatn as the default font family for Farsi.

- [#689](https://github.com/emdash-cms/emdash/pull/689) [`fa8d753`](https://github.com/emdash-cms/emdash/commit/fa8d7533e8ba7e02599372d580399dae88ecd891) Thanks [@edrpls](https://github.com/edrpls)! - Fixes the taxonomy term picker to match across diacritic boundaries.

  Typing `Mexico` in the admin picker now surfaces a term labeled `México` instead of prompting a duplicate create. Input and term labels are folded via NFD decomposition + lowercase before substring-matching, so editors who type without diacritics — or with locale keyboards that produce precomposed vs. combining forms — still see the canonical term.

  Before this fix, `"mexico"` and `"méxico"` were treated as distinct strings, so the picker showed zero suggestions and the editor had no way to find the existing term except to create a duplicate. Duplicate terms then split the taxonomy and broke public-facing filter pages that group content by slug.

  The exact-match check that gates the "Create new term" button uses the same fold, so typing `Mexico` when `México` exists also suppresses Create — closing the duplicate-creation loop.

- Updated dependencies []:
  - @emdash-cms/blocks@0.7.0

## 0.6.0

### Minor Changes

- [#565](https://github.com/emdash-cms/emdash/pull/565) [`913cb62`](https://github.com/emdash-cms/emdash/commit/913cb6239510f9959581cb74a70faa53a462a9aa) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Adds full RTL (right-to-left) support to the admin UI by converting all directional Tailwind classes to their direction-aware equivalents.

### Patch Changes

- [#610](https://github.com/emdash-cms/emdash/pull/610) [`dfcb0cd`](https://github.com/emdash-cms/emdash/commit/dfcb0cd4ed65d10212d47622b51a22b0eacf8acb) Thanks [@drudge](https://github.com/drudge)! - Passes plugin block definitions into the `PortableTextEditor` nested inside `WidgetEditor`, so custom plugin-registered block types (image blocks, marker blocks, etc.) can be inserted and rendered inside content-type widgets. The manifest is fetched with react-query in the top-level `Widgets` component, flattened into a `PluginBlockDef[]` list, and threaded through `WidgetAreaPanel` → `WidgetItem` → `WidgetEditor`.

- [#568](https://github.com/emdash-cms/emdash/pull/568) [`cf63b02`](https://github.com/emdash-cms/emdash/commit/cf63b0298576d062641cf88f37d6e7e86e4ddb3a) Thanks [@Vallhalen](https://github.com/Vallhalen)! - Fix document outline not showing headings on initial load. The outline now defers initial extraction to next tick (so TipTap finishes hydrating) and also listens for transaction events to catch programmatic content changes.

- [#564](https://github.com/emdash-cms/emdash/pull/564) [`0b32b2f`](https://github.com/emdash-cms/emdash/commit/0b32b2f3906bf5bfed313044af6371480d43edc1) Thanks [@ascorbic](https://github.com/ascorbic)! - Replaces the horizontal language-switch button bar on the admin login page with a dropdown, so the selector stays usable as more locales are added.

- [#592](https://github.com/emdash-cms/emdash/pull/592) [`6c92d58`](https://github.com/emdash-cms/emdash/commit/6c92d58767dc92548136a87cc90c1c6912da6695) Thanks [@asdfgl98](https://github.com/asdfgl98)! - Adds Korean locale support to the admin UI.

- [#559](https://github.com/emdash-cms/emdash/pull/559) [`a2d5afb`](https://github.com/emdash-cms/emdash/commit/a2d5afbb19b5bcaf98464d354322fa737a8b9ba0) Thanks [@ayfl269](https://github.com/ayfl269)! - Adds Chinese (Traditional) translation for the admin UI, including login page, settings page, and locale switching.

- [#604](https://github.com/emdash-cms/emdash/pull/604) [`39d285e`](https://github.com/emdash-cms/emdash/commit/39d285ea3d21b7b6277a554ae9cff011500655e1) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fixes loading spinner not centered under logo on the login page.

- Updated dependencies []:
  - @emdash-cms/blocks@0.6.0

## 0.5.0

### Minor Changes

- [#551](https://github.com/emdash-cms/emdash/pull/551) [`598026c`](https://github.com/emdash-cms/emdash/commit/598026c99083325c281b9e7ab87e9724e11f2c8d) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Adds RTL (right-to-left) language support infrastructure. Enables proper text direction for RTL languages like Arabic, Hebrew, Farsi, and Urdu. Includes LocaleDirectionProvider component that syncs HTML dir/lang attributes with Kumo's DirectionProvider for automatic layout mirroring when locale changes.

### Patch Changes

- [#489](https://github.com/emdash-cms/emdash/pull/489) [`9ea4cf7`](https://github.com/emdash-cms/emdash/commit/9ea4cf7c63cd5a1c45ec569bd72076c935066a1c) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Adds JSON field editor in admin UI content forms

- [#542](https://github.com/emdash-cms/emdash/pull/542) [`64f90d1`](https://github.com/emdash-cms/emdash/commit/64f90d1957af646ca200b9d70e856fa72393f001) Thanks [@mohamedmostafa58](https://github.com/mohamedmostafa58)! - Fixes invite flow: corrects invite URL to point to admin UI page, adds InviteAcceptPage for passkey registration.

- Updated dependencies []:
  - @emdash-cms/blocks@0.5.0

## 0.4.0

### Minor Changes

- [#516](https://github.com/emdash-cms/emdash/pull/516) [`20b03b4`](https://github.com/emdash-cms/emdash/commit/20b03b480156a5c901298a1ab9c968c800179215) Thanks [@erral](https://github.com/erral)! - Adds Basque (eu) translation

### Patch Changes

- [#490](https://github.com/emdash-cms/emdash/pull/490) [`3a96aa7`](https://github.com/emdash-cms/emdash/commit/3a96aa7f5671f6c718ab066e02c61fb55b33d901) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fixes mobile sidebar nav sections not displaying their pages

- [#87](https://github.com/emdash-cms/emdash/pull/87) [`c869df2`](https://github.com/emdash-cms/emdash/commit/c869df2b08decae6dc9c85bdfca83cc6577203cf) Thanks [@txhno](https://github.com/txhno)! - Fixes SEO sidebar text fields firing a PUT on every keystroke by debouncing saves; guards against stale server responses overwriting newer local edits.

- [#302](https://github.com/emdash-cms/emdash/pull/302) [`10ebfe1`](https://github.com/emdash-cms/emdash/commit/10ebfe19b81feacfe99cfaf2daf4976eaac17bd4) Thanks [@ideepakchauhan7](https://github.com/ideepakchauhan7)! - Fixes autosave form reset bug. Autosave no longer invalidates the query cache, preventing form fields from reverting to server state after autosave completes.

- [#36](https://github.com/emdash-cms/emdash/pull/36) [`275a21c`](https://github.com/emdash-cms/emdash/commit/275a21c389c121cbac6daa6be497ae3b6c1bfc6d) Thanks [@scottbuscemi](https://github.com/scottbuscemi)! - Fixes image field removal not persisting after save by sending null instead of undefined, which JSON.stringify was silently dropping.

- [#502](https://github.com/emdash-cms/emdash/pull/502) [`af0647c`](https://github.com/emdash-cms/emdash/commit/af0647c7352922ad63077613771150d8178263ed) Thanks [@pagelab](https://github.com/pagelab)! - Adds Portuguese (Brazil) locale with full pt-BR translations following the WordPress pt-BR glossary standard.

- [#521](https://github.com/emdash-cms/emdash/pull/521) [`b89e7f3`](https://github.com/emdash-cms/emdash/commit/b89e7f3811488ebe8fbe28068baa18f7f25844ad) Thanks [@ascorbic](https://github.com/ascorbic)! - Wraps all user-visible strings in the admin shell and core content screens with Lingui macros so they are translatable. Covers: Sidebar (nav labels, group headings), Header (View Site, Log out, Settings), ThemeToggle, Dashboard (headings, empty states, status indicators), ContentList (table headers, actions, dialogs, status badges), SaveButton, and ContentEditor (publish panel, schedule controls, byline editor, author selector, all dialogs). Runs `locale:extract` to add 116 new message IDs to all catalog files.

- [#528](https://github.com/emdash-cms/emdash/pull/528) [`ba0a5af`](https://github.com/emdash-cms/emdash/commit/ba0a5afccf110465b72916e23db4ff975d81bc2e) Thanks [@ascorbic](https://github.com/ascorbic)! - Wraps all remaining admin UI components with Lingui macros, completing full i18n coverage of the admin interface. Catalog grows from 296 to 1,216 message IDs. Covers media library, menus, sections, redirects, taxonomies, content types, field editor, plugins, marketplace, SEO panels, setup wizard, auth flows, and all settings pages.

- [#504](https://github.com/emdash-cms/emdash/pull/504) [`e2f96aa`](https://github.com/emdash-cms/emdash/commit/e2f96aa74bd936832a3a4d0636e81f948adb51c7) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes client-side locale switching and replaces toggle buttons with a Select dropdown.

- [#471](https://github.com/emdash-cms/emdash/pull/471) [`4645103`](https://github.com/emdash-cms/emdash/commit/4645103f06ae9481b07dba14af07ac0ff57e32cf) Thanks [@ayfl269](https://github.com/ayfl269)! - Adds Chinese (Simplified) translation for the admin UI, including login page, settings page, and locale switching.

- Updated dependencies []:
  - @emdash-cms/blocks@0.4.0

## 0.3.0

### Patch Changes

- [#351](https://github.com/emdash-cms/emdash/pull/351) [`c70f66f`](https://github.com/emdash-cms/emdash/commit/c70f66f7da66311fcf2f5922f23cdf951cdaff5f) Thanks [@CacheMeOwside](https://github.com/CacheMeOwside)! - Fixes redirect loops causing the ERR_TOO_MANY_REDIRECTS error, by detecting circular chains when creating or editing redirects on the admin Redirects page.

- [#499](https://github.com/emdash-cms/emdash/pull/499) [`0b4e61b`](https://github.com/emdash-cms/emdash/commit/0b4e61b059e40d7fc56aceb63d43004c8872005d) Thanks [@ascorbic](https://github.com/ascorbic)! - Fixes admin failing to load when installed from npm due to broken locale catalog resolution.

- Updated dependencies []:
  - @emdash-cms/blocks@0.3.0

## 0.2.0

### Minor Changes

- [#111](https://github.com/emdash-cms/emdash/pull/111) [`87b0439`](https://github.com/emdash-cms/emdash/commit/87b0439927454a275833992de4244678b47b9aa3) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Adds repeater field type for structured repeating data

### Patch Changes

- [#467](https://github.com/emdash-cms/emdash/pull/467) [`0966223`](https://github.com/emdash-cms/emdash/commit/09662232bd960e426ca00b10e7d49585aad00f99) Thanks [@sakibmd](https://github.com/sakibmd)! - fix: move useMemo above early returns in ContentListPage

- [#349](https://github.com/emdash-cms/emdash/pull/349) [`53dec88`](https://github.com/emdash-cms/emdash/commit/53dec8822bf486a1748e381087306f6097e6290c) Thanks [@tsikatawill](https://github.com/tsikatawill)! - Fixes menu editor rejecting relative URLs like /about by changing input type from url to text with pattern validation.

- [#99](https://github.com/emdash-cms/emdash/pull/99) [`3b6b75b`](https://github.com/emdash-cms/emdash/commit/3b6b75b01b5674776cb588506d75042d4a2745ea) Thanks [@all3f0r1](https://github.com/all3f0r1)! - Fix content list not fetching beyond the first API page when navigating to the last client-side page

- [#247](https://github.com/emdash-cms/emdash/pull/247) [`a293708`](https://github.com/emdash-cms/emdash/commit/a2937083f8f74e32ad1b0383d9f22b20e18d7237) Thanks [@NaeemHaque](https://github.com/NaeemHaque)! - Fixes email settings page showing empty by registering the missing API route. Adds error state to the admin UI so fetch failures are visible instead of silently swallowed.

- [#316](https://github.com/emdash-cms/emdash/pull/316) [`c9bf640`](https://github.com/emdash-cms/emdash/commit/c9bf64003d161a9517bd78599b3d7f8d0bf93cda) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Allow relative URLs in menu custom links by changing input type from "url" to "text"

- [#377](https://github.com/emdash-cms/emdash/pull/377) [`5eeab91`](https://github.com/emdash-cms/emdash/commit/5eeab918820f680ea8b46903df7d69969af8b8ee) Thanks [@Pouf5](https://github.com/Pouf5)! - Fixes new content always being created with locale `en` regardless of which locale is selected in the collection locale switcher. The "Add New" link now forwards the active locale to the new-content route, and the new-content page passes it through to the create API.

- [#185](https://github.com/emdash-cms/emdash/pull/185) [`e3f7db8`](https://github.com/emdash-cms/emdash/commit/e3f7db8bb670bb7444632ab0cd4e680e4c9029b3) Thanks [@ophirbucai](https://github.com/ophirbucai)! - Fixes field scroll-into-view not triggering when navigating to a field via URL parameter.

- [#93](https://github.com/emdash-cms/emdash/pull/93) [`a5e0603`](https://github.com/emdash-cms/emdash/commit/a5e0603b1910481d042f5a22dd19a60c76da7197) Thanks [@eyupcanakman](https://github.com/eyupcanakman)! - Fix taxonomy links missing from admin sidebar

- Updated dependencies [[`e1349e3`](https://github.com/emdash-cms/emdash/commit/e1349e342f90227c50f253cc2c1fbda0bc288a39)]:
  - @emdash-cms/blocks@0.2.0

## 0.1.1

### Patch Changes

- [#328](https://github.com/emdash-cms/emdash/pull/328) [`12d73ff`](https://github.com/emdash-cms/emdash/commit/12d73ff4560551bbe873783e4628bbd80809c449) Thanks [@jdevalk](https://github.com/jdevalk)! - Add OG Image field to content editor

- [#200](https://github.com/emdash-cms/emdash/pull/200) [`422018a`](https://github.com/emdash-cms/emdash/commit/422018aeb227dffe3da7bfc772d86f9ce9c2bcd1) Thanks [@ascorbic](https://github.com/ascorbic)! - Replace placeholder text branding with proper EmDash logo SVGs across admin UI, playground loading page, and preview interstitial

- [#306](https://github.com/emdash-cms/emdash/pull/306) [`71744fb`](https://github.com/emdash-cms/emdash/commit/71744fb8b2bcc7f48acea41f9866878463a4f4f7) Thanks [@JULJERYT](https://github.com/JULJERYT)! - Align back button position in API Tokens section

- [#135](https://github.com/emdash-cms/emdash/pull/135) [`018be7f`](https://github.com/emdash-cms/emdash/commit/018be7f1c3a8b399a9f38d7fa524e6f2908d95c3) Thanks [@fzihak](https://github.com/fzihak)! - Fix content list for large collections by implementing infinite scroll pagination

- [#181](https://github.com/emdash-cms/emdash/pull/181) [`9d10d27`](https://github.com/emdash-cms/emdash/commit/9d10d2791fe16be901d9d138e434bd79cf9335c4) Thanks [@ilicfilip](https://github.com/ilicfilip)! - fix(admin): use collection urlPattern for preview button fallback URL

- [#225](https://github.com/emdash-cms/emdash/pull/225) [`d211452`](https://github.com/emdash-cms/emdash/commit/d2114523a55021f65ee46e44e11157b06334819e) Thanks [@seslly](https://github.com/seslly)! - Adds `passkeyPublicOrigin` on `emdash()` so WebAuthn `origin` and `rpId` match the browser when dev sits behind a TLS-terminating reverse proxy. Validates the value at integration load time and threads it through all passkey-related API routes.

  Updates the admin passkey setup and login flows to detect non-secure origins and explain that passkeys need HTTPS or `http://localhost` rather than implying the browser lacks WebAuthn support.

- [#268](https://github.com/emdash-cms/emdash/pull/268) [`ab21f29`](https://github.com/emdash-cms/emdash/commit/ab21f29f713a5aa4c087c535608e1a2cab2ef9e0) Thanks [@doguabaris](https://github.com/doguabaris)! - Fixes passkey login error handling when no credential is returned from the authenticator

- [#221](https://github.com/emdash-cms/emdash/pull/221) [`bfcda12`](https://github.com/emdash-cms/emdash/commit/bfcda121400ee2bbbc35d666cc8bed38e0eba8ea) Thanks [@tohaitrieu](https://github.com/tohaitrieu)! - Fixes form state not updating when switching between taxonomy terms in the editor dialog.

- [#45](https://github.com/emdash-cms/emdash/pull/45) [`5f448d1`](https://github.com/emdash-cms/emdash/commit/5f448d1035073283fd7435d2f320d1f3c94898a0) Thanks [@Flynsarmy](https://github.com/Flynsarmy)! - Adds Back navigation to Security and Domain settings pages

## 0.1.0

### Minor Changes

- [#14](https://github.com/emdash-cms/emdash/pull/14) [`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4) Thanks [@ascorbic](https://github.com/ascorbic)! - First beta release

### Patch Changes

- Updated dependencies [[`755b501`](https://github.com/emdash-cms/emdash/commit/755b5017906811f97f78f4c0b5a0b62e67b52ec4)]:
  - @emdash-cms/blocks@0.1.0

## 0.0.2

### Patch Changes

- [#8](https://github.com/emdash-cms/emdash/pull/8) [`3c319ed`](https://github.com/emdash-cms/emdash/commit/3c319ed6411a595e6974a86bc58c2a308b91c214) Thanks [@ascorbic](https://github.com/ascorbic)! - Update branding
