export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

export type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies";

export interface GitHubRepository {
	owner: string;
	repo: string;
	directory: string;
}

export interface ProjectDependency {
	name: string;
	section: DependencySection;
	specifier: string;
	installedVersion: string;
}

export interface DependencyChange {
	name: string;
	section: DependencySection;
	from: string;
	to: string;
	fromVersion: string;
	toVersion: string;
	repository?: GitHubRepository;
}

export type ChangeCategory = "major" | "minor" | "patch";

export interface ChangelogOccurrence {
	packageName: string;
	version: string;
	category: ChangeCategory;
	source?: string;
}

export interface ChangelogEntry {
	body: string;
	occurrences: ChangelogOccurrence[];
}

export interface UpgradePlan {
	projectRoot: string;
	packageManager: PackageManager;
	tag: string;
	dependencies: DependencyChange[];
	changelog: ChangelogEntry[];
	migrations: {
		currentVersion: string;
		current: readonly string[];
		targetVersion?: string;
		target?: readonly string[];
		added?: string[];
	};
	guidePath: string;
	commands: {
		install: string;
		build: string;
		deploy?: string;
		migrationStatus: string;
		migrationApply: string;
		migrationCheck: string;
		syncSkills: string;
	};
}
