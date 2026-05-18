---
"@emdash-cms/plugin-cli": patch
---

Renames the multi-word flags on `build`, `dev`, and `bundle` from camelCase to kebab-case for consistency with `publish` and standard Unix CLI convention.

- `--outDir` -> `--out-dir`
- `--validateOnly` -> `--validate-only`

The short alias `-o` for `--out-dir` is unchanged.
