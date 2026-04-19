# @emdash-cms/admin

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
