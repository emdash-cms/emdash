---
"create-emdash": patch
---

Fixes pnpm commands in the `README.md` and `AGENTS.md` of sites created with npm, yarn, or bun. They now show the chosen package manager's commands, such as `npm run dev`, `yarn dev`, or `bun dev`. Bun uses `bun run build` and `bun run deploy`, because `bun build` and `bun deploy` run Bun's own commands instead of the site's scripts.
