---
"upgrade-emdash": minor
---

Adds `upgrade-emdash`, a project-aware command that updates direct EmDash packages and prepares the source and database work that package installation cannot do.

Run it from an existing site:

```sh
npx upgrade-emdash@latest
```

The command resolves the selected npm dist-tag separately for every direct `emdash` and `@emdash-cms/*` dependency. It preserves each dependency's caret, tilde, or exact version style, runs the project's package manager, refreshes the project skills from `emdash-cms/skills`, and writes `.emdash/UPGRADE.md`.

The work order contains the complete authored major, minor, and patch changelog entries crossed by those packages, fetched from their exact GitHub release tags. Generated dependency-bump entries and Changesets attribution wrappers are removed, and repeated entries are deduplicated without shortening their bodies.

The updater compares the core migration identities before and after installation. It does not edit application code, apply database migrations, or deploy. When the upgrade adds a core migration, the work order requires a successful target build, a restorable recovery point, migration-target review, and deployment of the same artifact that produced the migration manifest. An upgrade with no database-changing work does not require an upgrade-specific backup.
