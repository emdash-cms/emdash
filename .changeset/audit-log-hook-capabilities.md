---
"@emdash-cms/plugin-audit-log": patch
---

Fixes the `content:beforeSave` and `media:afterUpload` hooks being skipped at registration, which logged "[hooks] Plugin \"audit-log\" declares ... hook without ... capability — skipping" warnings on startup. Update entries now include before/after diffs again, and media uploads are audited. The manifest adds the `media:read` capability, and the before-save hook registers as a read-only observer, so the plugin still requests no write access. Restoring the hooks and the update diffs needs the `emdash` release that ships alongside this update (the `observe` hook option and the before-save event `id`); on older versions the plugin behaves as before.
