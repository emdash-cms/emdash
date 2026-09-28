---
"@emdash-cms/plugin-cli": patch
---

Fixes `emdash-plugin validate` accepting a manifest `name`, `description`, author name, or keyword longer than the registry package profile allows (100, 140, 64, and 64 graphemes), which made `release setup` fail later without naming the field. Commands that load or generate `emdash-plugin.jsonc`, such as `build`, `publish`, and `init`, now reject these values too and name the field and its limit. When a package profile still does not match the registry format, `profile setup` and `release setup` list the failing checks.
