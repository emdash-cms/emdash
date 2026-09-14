---
"@emdash-cms/plugin-cli": minor
---

Updates `emdash-plugin init` to produce a validated, package-manager-aware plugin project. Interactive setup shows the resolved publisher, author, security contact, repository, target, and package manager before writing. Non-interactive setup requires explicit ownership flags unless `--use-detected` opts into the active publisher session and local Git metadata.

Generated projects pin the plugin CLI version, use bounded EmDash dependencies, include validation and publishing scripts, and add `AGENTS.md` with a local `creating-plugins` skill. `.agents/skills` and `.claude/skills` link to the same canonical skill directory, while `.claude/CLAUDE.md` links to `AGENTS.md`. pnpm projects include the reviewed `esbuild` install policy and use an explicit `SandboxedPlugin` annotation so declaration output remains portable. The scaffolder validates the complete manifest and parent paths before writing and stages new projects atomically.
