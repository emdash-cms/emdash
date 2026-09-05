---
"@emdash-cms/plugin-audit-log": patch
---

Fixes the audit log never recording media uploads or the previous state of updated content. The plugin declared only `content:read`, so EmDash skipped its `content:beforeSave` and `media:afterUpload` hooks and logged `[hooks] Plugin "audit-log" declares content:beforeSave hook without content:write capability — skipping` on every boot.

The manifest now also declares `content:write` and `media:read`. EmDash requires `content:write` from any plugin that registers a `content:beforeSave` hook, because such a hook can rewrite the draft; the audit log returns the draft unchanged and only reads the stored item to record a before/after diff. Sites that installed the plugin from the marketplace are asked to approve the new capabilities when they update it. Recording the previous state of an update also needs an EmDash release that includes the item ID in the `content:beforeSave` event; on earlier EmDash releases the update entry is recorded without the previous state.
