# upgrade-emdash

## 0.1.0

### Minor Changes

- [#3804](https://github.com/emdash-cms/emdash/pull/3804) [`491b3b5`](https://github.com/emdash-cms/emdash/commit/491b3b5841e295bf6ed3c7371bd8275cfa5d5aa4) Thanks [@ascorbic](https://github.com/ascorbic)! - Adds `upgrade-emdash`, a project-aware command that updates direct EmDash packages and prepares the source and database work that package installation cannot do.
  
  Run it from an existing site:
  
  ```sh
  npx upgrade-emdash@latest
  ```
  
  The command resolves the selected npm dist-tag separately for every direct `emdash` and `@emdash-cms/*` dependency. It preserves each dependency's caret, tilde, or exact version style (replacing a preview build URL, git source, or other range with a caret range on the release, and updating pnpm catalog entries in `pnpm-workspace.yaml` for `catalog:` dependencies), runs the project's package manager (from the workspace root when the site is a workspace package), refreshes the project skills from `emdash-cms/skills`, and writes `.emdash/UPGRADE.md`. The project must already have `emdash` 0.35.0 or later installed in `node_modules`; Yarn Plug'n'Play installs are not supported.
  
  The work order contains the complete authored major, minor, and patch changelog entries crossed by those packages, fetched from their exact GitHub release tags. Generated dependency-bump entries and Changesets attribution wrappers are removed, and repeated entries are deduplicated without shortening their bodies.
  
  The updater compares the core migration identities before and after installation. It does not edit application code, apply database migrations, or deploy. When the upgrade adds a core migration, the work order requires a successful target build, a restorable recovery point, migration-target review, and deployment of the same artifact that produced the migration manifest. An upgrade with no database-changing work does not require an upgrade-specific backup.
