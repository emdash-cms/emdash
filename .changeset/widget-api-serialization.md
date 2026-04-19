---
"emdash": patch
---

Fixes `/_emdash/api/widget-areas/*` endpoints returning raw DB rows (snake_case fields, `content` as a JSON string) instead of the transformed `Widget` shape. Admin UI expects `content` to already be a parsed PortableText array and `componentId`/`componentProps`/`menuName` in camelCase, so expanding a content widget in `/_emdash/admin/widgets` produced an empty editor. All four route handlers (`GET /widget-areas`, `GET /widget-areas/:name`, `POST /widget-areas/:name/widgets`, `PUT /widget-areas/:name/widgets/:id`) now run their results through `rowToWidget`, which was made module-exported.
