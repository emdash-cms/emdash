---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/blocks": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/registry-lexicons": minor
---

Adds explicit, consented access to selected unsaved content for sandboxed editor panels and actions.

Plugins can request `admin.editor-draft:read` to receive extension-selected field values after an editor invokes them, and `admin.editor-draft:patch` to propose atomic whole-field `set` or `clear` operations. Patch access does not imply read access. Each extension must declare explicit collection scope and narrow its access to field slugs, translatable fields, or both.

EmDash authenticates and authorizes the saved entry, reloads its schema and revision, validates snapshot and patch limits, and rejects stale or invalid responses. The admin shows a host-rendered before-and-after preview, applies accepted changes to the visible form, marks it dirty, and leaves saving to the editor. Panel load and ordinary typing do not expose draft data or invoke the plugin.

`createPluginRuntimeTestHost()` now provides draft capture and host-validated patch application helpers for production-boundary plugin tests.
