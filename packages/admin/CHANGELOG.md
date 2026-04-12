# @emdash-cms/admin

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
