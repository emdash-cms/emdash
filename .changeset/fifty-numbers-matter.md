---
"create-emdash": patch
---

Pins `packageManager` for pnpm-scaffolded sites so a recent enough pnpm is used (settings-only `pnpm-workspace.yaml` requires pnpm 10.5+). For npm, yarn, or bun selections the field is stripped so corepack doesn't force pnpm on a non-pnpm user.
