import type { ChangelogEntry, UpgradePlan } from "./types.js";

function codeBlock(commands: readonly string[]): string {
	return `\`\`\`sh\n${commands.join("\n")}\n\`\`\``;
}

export function migrationBackupWarning(plan: UpgradePlan): string | undefined {
	if ((plan.migrations.added?.length ?? 0) === 0) return undefined;
	return "Before starting or deploying the upgraded build, create and verify a restorable database backup. A JSON backup is not a recovery point: https://docs.emdashcms.com/guides/backups/";
}

function renderEntry(entry: ChangelogEntry, index: number): string {
	const appliesTo = [
		...new Set(
			entry.occurrences.map(
				(occurrence) =>
					`\`${occurrence.packageName}@${occurrence.version}\` (${occurrence.category})`,
			),
		),
	].join(", ");
	const sources = [...new Set(entry.occurrences.flatMap((occurrence) => occurrence.source ?? []))];
	return `### Change ${index + 1}

Applies to: ${appliesTo}${sources.length > 0 ? `  \nSource: ${sources.join(", ")}` : ""}

${entry.body}`;
}

function renderMigrationGuide(plan: UpgradePlan): string {
	const added = plan.migrations.added ?? [];
	const deploy = plan.commands.deploy
		? `Deploy the same build artifact:\n\n${codeBlock([plan.commands.deploy])}`
		: "Deploy the same build artifact with the project's deployment workflow, without rebuilding it. On Cloudflare Workers, run `wrangler deploy`.";
	const apply = `${codeBlock([plan.commands.migrationApply])}

The command shows the target and asks for confirmation. In a non-interactive shell, add \`--expected-target-fingerprint\` with the target fingerprint that the status command printed for the reviewed database.`;
	const status = `Build the upgraded project and inspect the exact database target:\n\n${codeBlock([
		plan.commands.build,
		plan.commands.migrationStatus,
	])}`;
	const check = `Verify the deployed database against that artifact:\n\n${codeBlock([
		plan.commands.migrationCheck,
	])}`;

	if (added.length === 0) {
		return `## Core database migrations

Installed EmDash changed from \`${plan.migrations.currentVersion}\` to \`${plan.migrations.targetVersion}\`.

No core migrations were added by this upgrade.

${status}

If the status reports pending migrations, stop before starting or deploying the upgraded application. Follow [Backups and recovery](https://docs.emdashcms.com/guides/backups/) to create a restorable recovery point. A JSON backup is not a recovery point. After a human has reviewed the target and backup, apply the pending migrations:

${apply}

${deploy}

${check}`;
	}

	const migrations = added.map((migration) => `- \`${migration}\``).join("\n");
	return `## Core database migrations

Installed EmDash changed from \`${plan.migrations.currentVersion}\` to \`${plan.migrations.targetVersion}\`.

The target package adds these core migrations:

${migrations}

Do not apply migrations until the application changes compile and the target build has generated \`.emdash/migrations.json\`. Before starting or deploying the upgraded build, follow [Backups and recovery](https://docs.emdashcms.com/guides/backups/) to create a restorable database backup, back up media storage separately, and retain the \`EMDASH_ENCRYPTION_KEY\` rotation list. A JSON backup is not a recovery point. Apply migrations from the same build artifact that will be deployed.

${status}

After a human has reviewed the target and backup, apply pending migrations:

${apply}

${deploy}

${check}

Do not run migration \`down()\` functions or delete migration records to roll back. Restore the matching pre-migration database, media, keys, and application artifact together if recovery is required.`;
}

export function renderUpgradeGuide(plan: UpgradePlan): string {
	const packages =
		plan.dependencies.length > 0
			? plan.dependencies
					.map(
						(change) =>
							`- \`${change.name}\`: \`${change.fromVersion}\` → \`${change.toVersion}\` (\`${change.from}\` → \`${change.to}\`${change.catalog ? ` in the \`${change.catalog}\` pnpm catalog` : ""})`,
					)
					.join("\n")
			: "- All direct EmDash packages were already on the selected npm tag.";
	const catalogNote = plan.dependencies.some((change) => change.catalog)
		? "\n\nThe updater changed pnpm catalog entries in `pnpm-workspace.yaml`. The new versions apply to every workspace package that uses those catalog entries."
		: "";
	const changes =
		plan.changelog.length > 0
			? plan.changelog.map(renderEntry).join("\n\n")
			: "No authored changelog entries were crossed by this update.";
	return `# EmDash upgrade work order

This file is the handoff for upgrading the project at \`${plan.projectRoot}\` to the npm \`${plan.tag}\` release. The updater resolved the direct packages, changed and installed them where needed, refreshed the project EmDash skills, and compared the installed core migration manifests. It did not edit application code, apply a database migration, or deploy the site.

## Package changes

${packages}${catalogNote}

## Release entries to assess

These are the complete authored major, minor, and patch entries crossed by the direct EmDash packages in this project. Changesets dependency-bump entries and attribution wrappers have been removed. Check whether each entry affects code or configuration in this project. Do not adopt an unrelated feature merely because it appears here.

${changes}

## Agent skills

The updater ran:

${codeBlock([plan.commands.syncSkills])}

Use the refreshed \`upgrading-emdash\` skill for this work order. If the skills command reported a conflict or failure, resolve that before continuing.

${renderMigrationGuide(plan)}

## Verification

1. Assess every release entry above and make the project changes it requires.
2. Run the project's format, tests, typecheck, and build commands.
3. Inspect the migration target and pending names before applying them.
4. Verify the public site, admin sign-in, content editing, media reads, and encrypted plugin settings after deployment.
`;
}
