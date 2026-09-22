---
"emdash": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds `hooks.content-policy:register` for sandboxed and native plugins that need to inspect and reject publication, scheduling, or unpublication without receiving content read, write, or publication-action access.

Policy plugins can register `content:beforePublish`, `content:beforeSchedule`, and `content:beforeUnpublish`. Each event identifies the API, MCP, visual editor, plugin, scheduler, or system origin and includes the authenticated actor when one exists. Return `{ cancel: true, reason }` to reject the action with a stable error code. EmDash validates the reason as 1–500 plain-text characters. For allowed actions, the revision read before policy evaluation becomes the mutation precondition.

Scheduled content runs `content:beforePublish` again when it becomes due. A policy rejection unschedules the entry, lists its public-safe reason and entry link on the dashboard, and avoids retrying the same permanent rejection on every scheduler tick. Successful rescheduling, publication, or deletion clears the record; administrators can dismiss stale records. `@emdash-cms/plugin-test` exposes stored scheduler rejections through `inspect.scheduledPolicyRejections()`.
