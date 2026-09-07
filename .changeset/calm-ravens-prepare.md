---
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-client": minor
"@emdash-cms/registry-verification": minor
---

Adds interactive package-profile setup for delegated plugin releases. `emdash-plugin release setup` now creates a missing profile or adds delegated-release settings to an existing valid profile before writing the GitHub Actions workflow. Run `emdash-plugin profile setup` to prepare only the profile.

Interactive setup asks for the GitHub repository when it is absent from `emdash-plugin.jsonc`, lets you choose when releases require approval, and confirms the profile write. Non-interactive callers must pass `--yes` when a profile change is required.

The release service returns `PACKAGE_PROFILE_REQUIRED` before accepting artifact uploads when the signed profile is missing, lacks delegated-release settings, or names a different GitHub repository. Existing release intents also terminate with an actionable reason if their authoritative profile becomes invalid.
