# upgrade-emdash

Upgrade an EmDash project and prepare the source and database work that package installation cannot do.

Run the latest updater from the project directory:

```sh
npx upgrade-emdash@latest
```

The updater resolves the `latest` npm dist-tag independently for every direct `emdash` and `@emdash-cms/*` dependency. Use `--to next` or another dist-tag to choose a release channel. Exact versions are not accepted by `--to`; use the updater package version in the `npx` command when you need to reproduce an earlier updater implementation.

For each package, the updater preserves the existing caret, tilde, or exact dependency style and runs the project's package manager. It then:

- refreshes the project skills with `npx skills add emdash-cms/skills`
- fetches the crossed package changelogs from each exact GitHub release tag
- removes generated dependency-bump entries and Changesets attribution wrappers
- deduplicates authored entries repeated across packages without shortening their bodies
- compares the core migration identity before and after installation
- writes `.emdash/UPGRADE.md` for a coding agent or project owner

The work order contains all authored major, minor, and patch entries crossed by the project's direct EmDash packages. It also contains the added core migrations and the project's build, migration status, migration apply, deploy, and migration check commands.

The updater does not edit application code, apply database migrations, or deploy. Review the work order, build the project, inspect the migration target, and create restorable backups before authorizing any database change.

Inspect without changing files:

```sh
npx upgrade-emdash@latest --dry-run
```

Emit the same pre-install plan as JSON:

```sh
npx upgrade-emdash@latest --json
```

Apply without an interactive prompt:

```sh
npx upgrade-emdash@latest --yes
```

Dependencies must already be installed so the updater can identify the exact installed package versions and load `emdash/migrations`.
