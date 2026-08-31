---
"emdash": minor
---

Adds `ContentSaveRejectedError` so a `content:beforeSave` hook can reject a save with a message for the editor. Throwing it from a trusted plugin makes the content API respond with a structured `SAVE_REJECTED` error (HTTP 422) that carries the message, and the admin shows it in the save and autosave toasts. Any other exception thrown by the hook still cancels the save, but now returns a generic `CONTENT_HOOK_ERROR` response instead of escaping as an unstructured 500 that could leak exception details. A plugin running in the sandbox cannot reject a save yet; the save proceeds as before, and the sandbox log states that a sandboxed plugin cannot cancel a save. Moving the plugin into `plugins: []` runs it in the host process, where rejection works. The generated OpenAPI document lists the 422 response on content create and update.
