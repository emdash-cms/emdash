---
"@emdash-cms/plugin-cli": patch
---

Fixes generated delegated release workflows so the release Action can upload the selected plugin's `release.artifacts` icon, banner, and screenshots, including when the package requires provenance. Previously, delegated releases included only the package artifact.

Use the updated `emdash-cms/emdash/apps/release-action` for existing workflows. Root-level plugins need only the updated Action. For nested plugins, pass `plugin-directory: ${{ steps.prepare.outputs.plugin-directory }}` to the publish Action alongside `bundle-file`. Image paths are relative to that plugin's `emdash-plugin.jsonc` file.
