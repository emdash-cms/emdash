# upgrade-emdash

Upgrade an EmDash project and prepare the source and database work that package installation cannot do.

Run the latest updater from the project directory:

```sh
npx upgrade-emdash@latest
```

The updater resolves the `latest` npm dist-tag independently for every direct `emdash` and `@emdash-cms/*` dependency. Use `--to next` or another dist-tag to choose a release channel. Exact versions are not accepted by `--to`; use the updater package version in the `npx` command when you need to reproduce an earlier updater implementation.

For each package, the updater preserves the existing caret, tilde, or exact dependency style and runs the project's package manager. A preview build URL, git source, or other range becomes a caret range on the release. A `catalog:` dependency is updated in its pnpm catalog entry in `pnpm-workspace.yaml`, which also moves every workspace package that uses that entry. `workspace:`, local path, and `npm:` alias specifiers are left to the project, and the updater explains what to change. It then:

- refreshes the project skills with `npx --yes skills@1.7.0 add emdash-cms/skills -y`
- fetches the crossed package changelogs from each exact GitHub release tag
- removes generated dependency-bump entries and Changesets attribution wrappers
- deduplicates authored entries repeated across packages without shortening their bodies
- compares the core migration identity before and after installation
- writes `.emdash/UPGRADE.md` for a coding agent or project owner

The work order contains all authored major, minor, and patch entries crossed by the project's direct EmDash packages. It also contains the added core migrations and the project's build, migration status, migration apply, deploy, and migration check commands.

The updater does not edit application code, apply database migrations, or deploy. Review the work order, build the project, and inspect the migration target. Create a restorable recovery point before starting or deploying the upgraded application when the work order lists added migrations, the status command finds an earlier pending migration, or a release entry requires another data-changing action. A package update with no database-changing work does not require an upgrade-specific backup.

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

Dependencies must already be installed so the updater can identify the exact installed package versions and load `emdash/migrations`. Yarn Plug'n'Play installs are not supported; set `nodeLinker: node-modules` in `.yarnrc.yml` first.
