import { resolve } from "node:path";

import semver from "semver";

import { deduplicateChangelog, fetchChangelogRange } from "./changelog.js";
import {
	emdashCommand,
	installCommand,
	packageRun,
	targetSpecifier,
	type ProjectState,
} from "./project.js";
import { resolveRegistryRelease } from "./registry.js";
import type { ChangelogEntry, DependencyChange, UpgradePlan } from "./types.js";

function quotedCommand(command: string, args: readonly string[]): string {
	return [command, ...args].join(" ");
}

export async function createUpgradePlan(
	project: ProjectState,
	tag: string,
	fetcher: typeof fetch = fetch,
): Promise<UpgradePlan> {
	const releases = await Promise.all(
		project.dependencies.map((dependency) =>
			resolveRegistryRelease(dependency.name, tag, fetcher).then((release) => ({
				dependency,
				release,
			})),
		),
	);
	const dependencies: DependencyChange[] = releases.flatMap(({ dependency, release }) => {
		if (!semver.valid(dependency.installedVersion) || !semver.valid(release.version)) {
			throw new Error(
				`Cannot compare ${dependency.name} ${dependency.installedVersion} with ${release.version}.`,
			);
		}
		if (semver.gt(dependency.installedVersion, release.version)) {
			throw new Error(
				`${dependency.name}@${tag} is ${release.version}, older than the installed ${dependency.installedVersion}.`,
			);
		}
		const target = targetSpecifier(dependency.specifier, release.version);
		if (!target && dependency.installedVersion !== release.version) {
			throw new Error(
				`${dependency.name} uses ${dependency.specifier}. Update its workspace, catalog, alias, or non-semver specifier at the owning level, then run upgrade-emdash again.`,
			);
		}
		if (
			!target ||
			(dependency.installedVersion === release.version && target === dependency.specifier)
		) {
			return [];
		}
		return [
			{
				name: dependency.name,
				section: dependency.section,
				from: dependency.specifier,
				to: target,
				fromVersion: dependency.installedVersion,
				toVersion: release.version,
				repository: release.repository,
			},
		];
	});
	const changelogRanges = await Promise.all(
		releases.map(async ({ dependency, release }): Promise<ChangelogEntry[]> => {
			if (dependency.installedVersion === release.version) return [];
			if (!release.repository) {
				throw new Error(
					`${dependency.name}@${tag} does not publish a GitHub repository directory, so its upgrade changelog cannot be fetched.`,
				);
			}
			return fetchChangelogRange(
				release.repository,
				dependency.name,
				dependency.installedVersion,
				release.version,
				fetcher,
			);
		}),
	);
	const changelog = deduplicateChangelog(
		changelogRanges.flatMap((entries) =>
			entries.flatMap((entry) =>
				entry.occurrences.map((occurrence) => ({ body: entry.body, occurrence })),
			),
		),
	);
	const emdashRelease = releases.find(({ dependency }) => dependency.name === "emdash")?.release;
	if (!emdashRelease)
		throw new Error("The project does not declare emdash as a direct dependency.");
	const install = installCommand(project.packageManager);
	return {
		projectRoot: project.root,
		packageManager: project.packageManager,
		tag,
		dependencies,
		changelog,
		migrations: {
			currentVersion: project.currentVersion,
			current: project.migrations,
			targetVersion: emdashRelease.version,
		},
		guidePath: resolve(project.root, ".emdash", "UPGRADE.md"),
		commands: {
			install: quotedCommand(install.command, install.args),
			build: packageRun(project.packageManager, "build"),
			deploy: project.packageJson.scripts?.deploy
				? packageRun(project.packageManager, "deploy")
				: undefined,
			migrationStatus: emdashCommand(project.packageManager, "migrate --status"),
			migrationApply: emdashCommand(project.packageManager, "migrate"),
			migrationCheck: emdashCommand(project.packageManager, "migrate --check"),
			syncSkills: "npx --yes skills add emdash-cms/skills -y",
		},
	};
}

export function withTargetMigrations(plan: UpgradePlan, project: ProjectState): UpgradePlan {
	const current = new Set(plan.migrations.current);
	return {
		...plan,
		migrations: {
			...plan.migrations,
			targetVersion: project.currentVersion,
			target: project.migrations,
			added: project.migrations.filter((name) => !current.has(name)),
		},
	};
}
