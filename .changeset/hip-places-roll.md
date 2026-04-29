---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds an optional `category` field to `PortableTextBlockConfig` for plugin-contributed block types. Plugins can now choose how their blocks are grouped in the admin slash menu (e.g. "Sections", "Marketing", "Media", "Layout") instead of always falling under "Embeds". Existing plugins that omit the field continue to render under "Embeds" exactly as before.
