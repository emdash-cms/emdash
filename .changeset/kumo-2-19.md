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

Plugin admin pages built with Kumo may need changes for `Radio.Group` tests, `DatePicker` style overrides and `Dialog` maximum heights. [Upgrade to Kumo 2.19](https://docs.emdashcms.com/plugins/creating-native-plugins/distributing/#upgrade-to-kumo-219) describes each change, and [Match the admin's Kumo version](https://docs.emdashcms.com/plugins/creating-native-plugins/distributing/#match-the-admins-kumo-version) explains how a plugin pins Kumo.
