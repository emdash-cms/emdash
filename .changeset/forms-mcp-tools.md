---
"@emdash-cms/plugin-forms": minor
---

Adds MCP tools for reading forms and submissions and for triaging a submission: `forms_list`, `submissions_list`, `submissions_get` and `submissions_update`. An API token could not reach submissions without the full `admin` scope, because plugin REST routes require it; these tools use the plugin MCP scope instead, once a site admin enables them for the plugin. Deleting, exporting and editing forms are not offered. The forms list also accepts `limit` and `cursor`, so a site with more than 100 forms can be read in full.
