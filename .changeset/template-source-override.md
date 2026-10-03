---
"create-emdash": minor
---

Adds an `EMDASH_TEMPLATES_REPO` environment variable to `create-emdash` so scaffolding can pull templates from a different `owner/repo` on GitHub instead of the default `emdash-cms/templates`.

Also accepts ad-hoc template names: a `--template` value outside the built-in list is now downloaded as a literal directory from the templates repo instead of being rejected, so downstream and private template repos can ship templates without a core CLI change. Names that cannot be a repo-relative directory (spaces, `..` segments, empty) are still rejected.
