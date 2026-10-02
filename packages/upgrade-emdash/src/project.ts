import { spawn } from "node:child_process";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { applyEdits, modify } from "jsonc-parser";

import type {
	DependencyChange,
	DependencySection,
	PackageManager,
	ProjectDependency,
} from "./types.js";

export interface ProjectPackage {
	[key: string]: unknown;
	packageManager?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

interface InstalledMigrationModule {
	getCoreMigrationIdentity: () => Promise<{ emdashVersion: string; names: readonly string[] }>;
}

export interface ProjectState {
	root: string;
	packageJsonPath: string;
	packageJsonSource: string;
	packageJson: ProjectPackage;
	packageManager: PackageManager;
	dependencies: ProjectDependency[];
	currentVersion: string;
	migrations: readonly string[];
}

const SECTIONS: readonly DependencySection[] = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
];
const SIMPLE_VERSION = /^(\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every((entry) => typeof entry === "string")
	);
}

function isProjectPackage(value: unknown): value is ProjectPackage {
	if (typeof value !== "object" || value === null) return false;
	const packageManager = Reflect.get(value, "packageManager");
	if (packageManager !== undefined && typeof packageManager !== "string") return false;
	return ["scripts", "dependencies", "devDependencies", "optionalDependencies"].every((key) => {
		const entry = Reflect.get(value, key);
		return entry === undefined || isStringRecord(entry);
	});
}

function isInstalledMigrationModule(value: unknown): value is InstalledMigrationModule {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "getCoreMigrationIdentity") === "function"
	);
}

function isEmDashPackage(name: string): boolean {
	return name === "emdash" || name.startsWith("@emdash-cms/");
}

export async function findProjectRoot(start: string): Promise<string> {
	let current = resolve(start);
	const filesystemRoot = parse(current).root;
	for (;;) {
		if (await pathExists(resolve(current, "package.json"))) return current;
		if (current === filesystemRoot) break;
		current = dirname(current);
	}
	throw new Error("Could not find a project package.json.");
}

export async function detectPackageManager(
	root: string,
	packageManager?: string,
): Promise<PackageManager> {
	const declared = packageManager?.split("@")[0];
	if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") {
		return declared;
	}
	const lockfiles: readonly [string, PackageManager][] = [
		["pnpm-lock.yaml", "pnpm"],
		["bun.lock", "bun"],
		["bun.lockb", "bun"],
		["yarn.lock", "yarn"],
		["package-lock.json", "npm"],
	];
	for (const [lockfile, manager] of lockfiles) {
		if (await pathExists(resolve(root, lockfile))) return manager;
	}
	return "npm";
}

async function findInstalledPackageJson(
	root: string,
	packageJsonPath: string,
	name: string,
): Promise<string> {
	const directPath = resolve(root, "node_modules", ...name.split("/"), "package.json");
	if (await pathExists(directPath)) return directPath;

	const requireFromProject = createRequire(packageJsonPath);
	try {
		return requireFromProject.resolve(`${name}/package.json`);
	} catch {
		let entryPath: string;
		try {
			entryPath = requireFromProject.resolve(name);
		} catch {
			throw new Error(
				`Install the project's dependencies before running upgrade-emdash (${name} is missing).`,
			);
		}
		let current = dirname(await realpath(entryPath));
		const filesystemRoot = parse(current).root;
		for (;;) {
			const candidate = resolve(current, "package.json");
			if (await pathExists(candidate)) {
				const value: unknown = JSON.parse(await readFile(candidate, "utf8"));
				if (typeof value === "object" && value !== null && Reflect.get(value, "name") === name) {
					return candidate;
				}
			}
			if (current === filesystemRoot) break;
			current = dirname(current);
		}
	}
	throw new Error(`Could not find the installed package.json for ${name}.`);
}

async function installedVersion(
	root: string,
	packageJsonPath: string,
	name: string,
): Promise<string> {
	const installedPath = await findInstalledPackageJson(root, packageJsonPath, name);
	const value: unknown = JSON.parse(await readFile(installedPath, "utf8"));
	const version =
		typeof value === "object" && value !== null ? Reflect.get(value, "version") : null;
	if (typeof version !== "string") throw new Error(`${name} has no installed version.`);
	return version;
}

async function loadMigrationIdentity(packageJsonPath: string): Promise<{
	emdashVersion: string;
	names: readonly string[];
}> {
	const requireFromProject = createRequire(packageJsonPath);
	let migrationsPath: string;
	try {
		migrationsPath = requireFromProject.resolve("emdash/migrations");
	} catch {
		throw new Error("Install the project's dependencies before running upgrade-emdash.");
	}
	const resolvedPath = await realpath(migrationsPath);
	const installedEmDashVersion = await installedVersion(
		dirname(packageJsonPath),
		packageJsonPath,
		"emdash",
	);
	const migrationModule: unknown = await import(
		`${pathToFileURL(resolvedPath).href}?emdash=${encodeURIComponent(installedEmDashVersion)}`
	);
	if (!isInstalledMigrationModule(migrationModule)) {
		throw new Error("The installed EmDash package does not expose its migration identity.");
	}
	return migrationModule.getCoreMigrationIdentity();
}

export async function loadProject(start: string): Promise<ProjectState> {
	const root = await findProjectRoot(start);
	const packageJsonPath = resolve(root, "package.json");
	const packageJsonSource = await readFile(packageJsonPath, "utf8");
	const packageJson: unknown = JSON.parse(packageJsonSource);
	if (!isProjectPackage(packageJson)) throw new Error("The project package.json is invalid.");
	const packageManager = await detectPackageManager(root, packageJson.packageManager);
	const dependencies: ProjectDependency[] = [];
	for (const section of SECTIONS) {
		for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
			if (!isEmDashPackage(name)) continue;
			dependencies.push({
				name,
				section,
				specifier,
				installedVersion: await installedVersion(root, packageJsonPath, name),
			});
		}
	}
	if (!dependencies.some((dependency) => dependency.name === "emdash")) {
		throw new Error("The project does not declare emdash as a direct dependency.");
	}
	const identity = await loadMigrationIdentity(packageJsonPath);
	const emdashVersion = dependencies.find(
		(dependency) => dependency.name === "emdash",
	)?.installedVersion;
	if (emdashVersion !== identity.emdashVersion) {
		throw new Error(
			`The installed emdash package is ${emdashVersion}, but emdash/migrations reports ${identity.emdashVersion}. Reinstall or rebuild the project's dependencies before upgrading.`,
		);
	}
	return {
		root,
		packageJsonPath,
		packageJsonSource,
		packageJson,
		packageManager,
		dependencies,
		currentVersion: identity.emdashVersion,
		migrations: identity.names,
	};
}

export function targetSpecifier(current: string, targetVersion: string): string | null {
	const match = current.match(SIMPLE_VERSION);
	if (!match) return null;
	return `${match[1] ?? ""}${targetVersion}`;
}

export function applyDependencyChanges(
	packageJson: ProjectPackage,
	changes: readonly DependencyChange[],
): ProjectPackage {
	const updated = structuredClone(packageJson);
	for (const change of changes) {
		const dependencies = updated[change.section];
		if (dependencies) dependencies[change.name] = change.to;
	}
	return updated;
}

export function applyDependencyEdits(
	packageJsonSource: string,
	changes: readonly DependencyChange[],
): string {
	let updated = packageJsonSource;
	for (const change of changes) {
		updated = applyEdits(updated, modify(updated, [change.section, change.name], change.to, {}));
	}
	return updated;
}

export function installCommand(packageManager: PackageManager): {
	command: string;
	args: string[];
} {
	switch (packageManager) {
		case "bun":
			return { command: "bun", args: ["install"] };
		case "npm":
			return { command: "npm", args: ["install"] };
		case "pnpm":
			return { command: "pnpm", args: ["install"] };
		case "yarn":
			return { command: "yarn", args: ["install"] };
	}
}

export function packageRun(packageManager: PackageManager, script: string): string {
	return packageManager === "npm" || packageManager === "bun"
		? `${packageManager} run ${script}`
		: `${packageManager} ${script}`;
}

export function emdashCommand(packageManager: PackageManager, args: string): string {
	switch (packageManager) {
		case "bun":
			return `bunx emdash ${args}`;
		case "npm":
			return `npm exec -- emdash ${args}`;
		case "pnpm":
			return `pnpm exec emdash ${args}`;
		case "yarn":
			return `yarn emdash ${args}`;
	}
}

export function run(command: string, args: readonly string[], cwd: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const executable = process.platform === "win32" && command === "npx" ? "npx.cmd" : command;
		const child = spawn(executable, args, { cwd, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else {
				reject(
					new Error(`${command} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}.`),
				);
			}
		});
	});
}

export async function writeDependenciesAndInstall(
	project: ProjectState,
	changes: readonly DependencyChange[],
): Promise<void> {
	if (changes.length === 0) return;
	const updated = applyDependencyEdits(project.packageJsonSource, changes);
	await writeFile(project.packageJsonPath, updated);
	const install = installCommand(project.packageManager);
	const lockfiles = {
		bun: ["bun.lock", "bun.lockb"],
		npm: ["package-lock.json"],
		pnpm: ["pnpm-lock.yaml"],
		yarn: ["yarn.lock"],
	}[project.packageManager];
	const lockfileSources = await Promise.all(
		lockfiles.map(async (name) => {
			const path = resolve(project.root, name);
			return { path, source: (await pathExists(path)) ? await readFile(path) : null };
		}),
	);
	try {
		await run(install.command, install.args, project.root);
	} catch (error) {
		await writeFile(project.packageJsonPath, project.packageJsonSource);
		for (const lockfile of lockfileSources) {
			if (lockfile.source) await writeFile(lockfile.path, lockfile.source);
			else await rm(lockfile.path, { force: true });
		}
		throw error;
	}
}
