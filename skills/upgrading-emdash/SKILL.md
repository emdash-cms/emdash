---
name: upgrading-emdash
description: Upgrade an existing EmDash project with upgrade-emdash, interpret .emdash/UPGRADE.md, apply required project changes, and verify the package, skill, and migration result. Use when asked to update or upgrade EmDash dependencies. Do not use for an unrelated schema change or a known database migration without a package upgrade.
---

# Upgrading EmDash

Use `upgrade-emdash` to resolve the selected npm release tag, update every direct EmDash package, refresh the EmDash skills, and create the project-specific work order. The updater does not edit application code, apply database migrations, or deploy.

## Prepare the work order

Run from the project root:

```sh
npx upgrade-emdash@latest --dry-run
npx upgrade-emdash@latest
```

Use `--to <tag>` for another npm dist-tag such as `next` or `beta`. `--to` does not accept a version. Use `--yes` to accept the updater prompt in a non-interactive environment, `--json` for a machine-readable dry-run, and `--cwd <path>` when the project root is elsewhere.

The updater writes `.emdash/UPGRADE.md`. Read that file after the command finishes. It contains the complete authored changelog entries crossed by the direct packages in this project, with generated dependency-bump entries removed, plus the exact core migration delta found after installation.

## Complete the upgrade

1. Inspect the existing project and its uncommitted changes. Preserve unrelated work.
2. Assess every release entry in `.emdash/UPGRADE.md` against the project. Apply required source and configuration changes. Do not adopt a new feature when the project does not use the affected surface.
3. Run the repository's relevant format, tests, typecheck, and build commands.
4. Run the migration status command from the work order and report the target database and pending migrations.
5. Ask before applying a migration to a database, deploying, or making any other remote change unless the user explicitly included that action in the request.
6. After authorized migration and deployment work, run the migration check and verify the affected site paths.

Treat core migrations as forward-only. Before an authorized apply, require a restorable database backup, a separate media backup, the relevant encryption keys, and the same build artifact for migration and deployment. Roll back by restoring the matching database and application artifact together, not by running migration `down()` functions or deleting migration records.
