---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds a version picker to the registry plugin detail page. Older releases of a registry-hosted plugin are now selectable from a dropdown next to the Install button, and the displayed version, indexed date, permissions, and source link swap to match the selected release. Pre-release versions (e.g. `1.0.0-alpha.1`) are flagged with a "Pre-release" badge so admins can spot them before installing. Versions still inside the configured minimum-release-age holdback remain visible in the dropdown but stay non-installable until they age into the window.
