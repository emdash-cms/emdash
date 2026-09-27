---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds two settings to the Navigation section of the content type editor:

- **Icon**: the Phosphor icon name shown for the collection in the admin sidebar and in command palette navigation, such as `calendar-blank`. A sidebar folder shows the icon of the first collection in it that declares one. A name that does not resolve falls back to the collection's default icon.
- **Hide from navigation**: removes the collection's sidebar entry, its command palette link, and its dashboard quick action. The collection stays reachable by URL, the API, and plugins. Collections that were already hidden now also drop out of the command palette.

#### API and seed files

The manifest now publishes each collection's `icon`. Collection icon names are now trimmed and limited to 64 characters in the schema API and the MCP collection tools, and limited to 64 characters in seed files, so longer values are rejected. Sending an empty `icon` clears the stored icon.
