---
"@emdash-cms/admin": patch
"@emdash-cms/blocks": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/plugin-forms": patch
"@emdash-cms/plugin-field-kit": patch
"@emdash-cms/plugin-ai-moderation": patch
"@emdash-cms/plugin-ai-search": patch
---

Updates `@cloudflare/kumo` to 2.19.0. These packages now require exactly `@cloudflare/kumo@2.19.0`, so sites and plugins that install Kumo themselves should upgrade to that version to match the admin's prebuilt styles. Update `emdash` and the Forms, Field Kit, AI Moderation and AI Search plugins together, since their earlier releases require Kumo 2.15.0.

In the admin, date pickers use Kumo's refreshed day and month buttons, and button labels are vertically centred.

Plugin admin pages built with Kumo may need these changes. The [Kumo changelog](https://github.com/cloudflare/kumo/blob/main/packages/kumo/CHANGELOG.md) lists everything that changed from 2.16.0 to 2.19.0.

- `Radio.Group` now renders a single `<fieldset role="radiogroup">`. Tests that find a radio group with `getByRole("group", { name })` should use `getByRole("radiogroup", { name })`.
- `DatePicker` no longer has `.rdp-*` styles or `--rdp-*` variables, and each `classNames` key you pass replaces Kumo's classes for that part. Remove old overrides such as `day_button` or `month_grid`, and pass layout classes through `className`.
- `Dialog` now keeps within the window's height. On screens 640px wide and up, that limit overrides a `max-h-*` class on the dialog, so set a dialog's own maximum height with `style={{ maxHeight }}` instead.
