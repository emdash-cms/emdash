---
"emdash": patch
"@emdash-cms/admin": patch
---

Adds cancel and abandon controls for site exports so a stuck export can be stopped without editing the database.

- `emdash site export cancel <operation-id>` and `emdash site export abandon <operation-id>` stop a pending/running export or clean up a failed/cancelled one.
- The admin **Settings → Transfer** page now shows a **Cancel export** button while an export is running.
- The REST API adds `POST /_emdash/api/admin/transfer/exports/{id}/cancel` and `.../abandon`.
- The MCP server adds `site_export_cancel` and `site_export_abandon` tools, gated on `transfer:export` (or the approval grant that started the export).
- Exports that repeatedly advance without making progress now fail with `TRANSFER_EXPORT_STALLED` instead of renewing the lease forever.
- Cancelled and abandoned exports are eligible for staging cleanup.
