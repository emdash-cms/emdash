import { resolve } from "node:path";

import semver from "semver";

import { catalogEntry, catalogName } from "./catalog.js";
import { deduplicateChangelog, fetchChangelogRange } from "./changelog.js";
import {
	emdashCommand,
	installCommand,
	packageRun,
	SYNC_SKILLS,
	targetSpecifier,
	unsupportedSpecifierMessage,
	type ProjectState,
} from "./project.js";
import { resolveRegistryRelease } from "./registry.js";
import type { ChangelogEntry, DependencyChange, ProjectDependency, UpgradePlan } from "./types.js";

const REBUILDS = /\bbuild\b/;

function commandLine(command: string, args: readonly string[]): string {
	return [command, ...args].join(" ");
}

function versionSource(
	project: ProjectState,
	dependency: ProjectDependency,
): { catalog?: string; specifier: string } | { problem: string } {
	const catalog = catalogName(dependency.specifier);
	if (!catalog) return { specifier: dependency.specifier };
	const uses = `${dependency.name} uses ${dependency.specifier}`;
	const manifest = project.workspaceManifest;
	if (!manifest) {
		return {
			problem: `${uses}, but there is no pnpm-workspace.yaml at ${project.installRoot}. upgrade-emdash updates pnpm catalogs only.`,
		};
	}
	const specifier = catalogEntry(manifest.source, catalog, dependency.name);
	if (specifier === undefined) {
		return {
			problem: `${uses}, but the ${catalog} catalog in ${manifest.path} has no ${dependency.name} entry.`,
		};
	}
	return { catalog, specifier };
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
		const source = versionSource(project, dependency);
		const target = "problem" in source ? null : targetSpecifier(source.specifier, release.version);
		if (!target && dependency.installedVersion !== release.version) {
			throw new Error(
				"problem" in source
					? source.problem
					: unsupportedSpecifierMessage(dependency.name, source.specifier, release.version),
			);
		}
		if (
			!target ||
			"problem" in source ||
			(dependency.installedVersion === release.version && target === source.specifier)
		) {
			return [];
		}
		return [
			{
				name: dependency.name,
				section: dependency.section,
				...(source.catalog ? { catalog: source.catalog } : {}),
				from: source.specifier,
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
	const deployScript = project.packageJson.scripts?.deploy;
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
			install: commandLine(install.command, install.args),
			build: packageRun(project.packageManager, "build"),
			deploy:
				deployScript && !REBUILDS.test(deployScript)
					? packageRun(project.packageManager, "deploy")
					: undefined,
			migrationStatus: emdashCommand(project.packageManager, "migrate --status"),
			migrationApply: emdashCommand(project.packageManager, "migrate"),
			migrationCheck: emdashCommand(project.packageManager, "migrate --check"),
			syncSkills: commandLine(SYNC_SKILLS.command, SYNC_SKILLS.args),
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
