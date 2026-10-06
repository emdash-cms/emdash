import { execFile, spawn } from "node:child_process";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, parse, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { applyEdits, modify } from "jsonc-parser";
import { minimatch } from "minimatch";
import semver from "semver";
import { parse as parseYaml } from "yaml";

import { applyCatalogEdits } from "./catalog.js";
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

const MISSING_MIGRATIONS_EXIT_CODE = 3;
const MIGRATION_IDENTITY_SCRIPT = `
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
let path;
try {
	path = createRequire(process.argv[1]).resolve("emdash/migrations");
} catch {
	process.exit(${MISSING_MIGRATIONS_EXIT_CODE});
}
const { getCoreMigrationIdentity } = await import(pathToFileURL(path).href);
const { emdashVersion, names } = await getCoreMigrationIdentity();
process.stdout.write("\\n" + JSON.stringify({ emdashVersion, names }) + "\\n");
`;

const execFileAsync = promisify(execFile);

export interface ProjectState {
	root: string;
	installRoot: string;
	workspaceManifest?: { path: string; source: string };
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
const MINIMUM_EMDASH_VERSION = "0.35.0";

export const SYNC_SKILLS = {
	command: "npx",
	args: ["--yes", "skills@1.7.0", "add", "emdash-cms/skills", "-y"],
} as const;
const PROJECT_MANAGED_SPECIFIER = /^(?:catalog|workspace|link|file|portal|npm):/;
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

function isMigrationIdentity(
	value: unknown,
): value is { emdashVersion: string; names: readonly string[] } {
	if (typeof value !== "object" || value === null) return false;
	const names = Reflect.get(value, "names");
	return (
		typeof Reflect.get(value, "emdashVersion") === "string" &&
		Array.isArray(names) &&
		names.every((name) => typeof name === "string")
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

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string")
		? value
		: undefined;
}

async function workspacePatterns(directory: string): Promise<string[] | undefined> {
	try {
		const pnpmWorkspacePath = resolve(directory, "pnpm-workspace.yaml");
		if (await pathExists(pnpmWorkspacePath)) {
			const value: unknown = parseYaml(await readFile(pnpmWorkspacePath, "utf8"));
			const packages =
				typeof value === "object" && value !== null ? Reflect.get(value, "packages") : undefined;
			return stringArray(packages) ?? [];
		}
		const packageJsonPath = resolve(directory, "package.json");
		if (!(await pathExists(packageJsonPath))) return undefined;
		const value: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const workspaces: unknown = Reflect.get(value, "workspaces");
		if (typeof workspaces === "object" && workspaces !== null && !Array.isArray(workspaces)) {
			return stringArray(Reflect.get(workspaces, "packages"));
		}
		return stringArray(workspaces);
	} catch {
		return undefined;
	}
}

const LEADING_DOT_SLASH = /^\.\//;
const TRAILING_SLASHES = /\/+$/;

function normalizeWorkspacePattern(pattern: string): string {
	return pattern.replace(LEADING_DOT_SLASH, "").replace(TRAILING_SLASHES, "");
}

function workspaceIncludes(patterns: readonly string[], packagePath: string): boolean {
	let included = false;
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) {
			if (minimatch(packagePath, normalizeWorkspacePattern(pattern.slice(1)))) return false;
		} else if (minimatch(packagePath, normalizeWorkspacePattern(pattern))) {
			included = true;
		}
	}
	return included;
}

export async function findInstallRoot(root: string): Promise<string> {
	const filesystemRoot = parse(root).root;
	let current = root;
	while (current !== filesystemRoot) {
		current = dirname(current);
		const patterns = await workspacePatterns(current);
		if (patterns && workspaceIncludes(patterns, relative(current, root).split(sep).join("/"))) {
			return current;
		}
	}
	return root;
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
	const topDirectory = parse(root).root;
	for (let directory = root; ; directory = dirname(directory)) {
		const candidate = resolve(directory, "node_modules", ...name.split("/"), "package.json");
		if (await pathExists(candidate)) return candidate;
		if (directory === topDirectory) break;
	}

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
	// A fresh process sees the packages installed during this run; this process caches module resolution.
	let stdout: string;
	try {
		({ stdout } = await execFileAsync(
			process.execPath,
			["--input-type=module", "--eval", MIGRATION_IDENTITY_SCRIPT, packageJsonPath],
			{ cwd: dirname(packageJsonPath), maxBuffer: 16 * 1024 * 1024 },
		));
	} catch (error) {
		const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
		if (code === MISSING_MIGRATIONS_EXIT_CODE) {
			throw new Error("Install the project's dependencies before running upgrade-emdash.", {
				cause: error,
			});
		}
		throw new Error("The installed EmDash package could not report its migration identity.", {
			cause: error,
		});
	}
	const identity: unknown = JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "null");
	if (!isMigrationIdentity(identity)) {
		throw new Error("The installed EmDash package does not expose its migration identity.");
	}
	return identity;
}

export async function loadProject(start: string): Promise<ProjectState> {
	const root = await findProjectRoot(start);
	const packageJsonPath = resolve(root, "package.json");
	const packageJsonSource = await readFile(packageJsonPath, "utf8");
	const packageJson: unknown = JSON.parse(packageJsonSource);
	if (!isProjectPackage(packageJson)) throw new Error("The project package.json is invalid.");
	const installRoot = await findInstallRoot(root);
	if (await pathExists(resolve(installRoot, ".pnp.cjs"))) {
		throw new Error(
			"This project uses Yarn Plug'n'Play, which installs packages without node_modules. upgrade-emdash needs a node_modules install: set nodeLinker: node-modules in .yarnrc.yml and run yarn install, or update the EmDash packages with yarn up.",
		);
	}
	const packageManager = await detectPackageManager(installRoot, packageJson.packageManager);
	const workspaceManifestPath = resolve(installRoot, "pnpm-workspace.yaml");
	const workspaceManifest =
		packageManager === "pnpm" && (await pathExists(workspaceManifestPath))
			? { path: workspaceManifestPath, source: await readFile(workspaceManifestPath, "utf8") }
			: undefined;
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
	const emdashVersion = dependencies.find(
		(dependency) => dependency.name === "emdash",
	)?.installedVersion;
	if (!emdashVersion) {
		throw new Error("The project does not declare emdash as a direct dependency.");
	}
	if (semver.valid(emdashVersion) && semver.lt(emdashVersion, MINIMUM_EMDASH_VERSION)) {
		throw new Error(
			`upgrade-emdash requires emdash ${MINIMUM_EMDASH_VERSION} or later, but this project has ${emdashVersion}. Update the direct EmDash packages to ${MINIMUM_EMDASH_VERSION} or later with the project's package manager, following https://docs.emdashcms.com/deployment/updating/#before-you-update, then run upgrade-emdash again.`,
		);
	}
	const identity = await loadMigrationIdentity(packageJsonPath);
	if (emdashVersion !== identity.emdashVersion) {
		throw new Error(
			`The installed emdash package is ${emdashVersion}, but emdash/migrations reports ${identity.emdashVersion}. Reinstall or rebuild the project's dependencies before upgrading.`,
		);
	}
	return {
		root,
		installRoot,
		...(workspaceManifest ? { workspaceManifest } : {}),
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
	if (PROJECT_MANAGED_SPECIFIER.test(current)) return null;
	const match = current.match(SIMPLE_VERSION);
	if (!match) return `^${targetVersion}`;
	return `${match[1] ?? ""}${targetVersion}`;
}

export function unsupportedSpecifierMessage(
	name: string,
	specifier: string,
	targetVersion: string,
): string {
	const release = `"${name}": "^${targetVersion}"`;
	if (specifier.startsWith("workspace:")) {
		return `${name} uses ${specifier}, so it comes from a package in this workspace rather than from npm. upgrade-emdash only updates packages installed from npm.`;
	}
	if (specifier.startsWith("npm:")) {
		return `${name} is an alias for ${specifier}. upgrade-emdash cannot tell which package the alias should install. Replace it with ${release} in package.json, or update the alias yourself, then run upgrade-emdash again.`;
	}
	return `${name} uses ${specifier}, a local path. upgrade-emdash only updates packages installed from npm. Replace it with ${release} in package.json to install the release, then run upgrade-emdash again.`;
}

export function applyDependencyChanges(
	packageJson: ProjectPackage,
	changes: readonly DependencyChange[],
): ProjectPackage {
	const updated = structuredClone(packageJson);
	for (const change of changes) {
		if (change.catalog) continue;
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
		if (change.catalog) continue;
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
		// Package manager commands are .cmd shims on Windows, which Node only runs through a shell.
		const child =
			process.platform === "win32"
				? spawn([command, ...args].join(" "), { cwd, stdio: "inherit", shell: true })
				: spawn(command, args, { cwd, stdio: "inherit" });
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

async function restoreFiles(
	files: readonly { path: string; source: string | Buffer | null }[],
): Promise<void> {
	for (const file of files) {
		if (file.source !== null) await writeFile(file.path, file.source);
		else await rm(file.path, { force: true });
	}
}

export async function writeDependenciesAndInstall<T>(
	project: ProjectState,
	changes: readonly DependencyChange[],
	verify: () => Promise<T>,
): Promise<T> {
	if (changes.length === 0) return verify();
	const install = installCommand(project.packageManager);
	const lockfiles = {
		bun: ["bun.lock", "bun.lockb"],
		npm: ["package-lock.json"],
		pnpm: ["pnpm-lock.yaml"],
		yarn: ["yarn.lock"],
	}[project.packageManager];
	const catalogEdits = changes.flatMap((change) =>
		change.catalog
			? [{ catalog: change.catalog, packageName: change.name, specifier: change.to }]
			: [],
	);
	const workspaceManifest = catalogEdits.length > 0 ? project.workspaceManifest : undefined;
	if (catalogEdits.length > 0 && !workspaceManifest) {
		throw new Error(`The pnpm catalog changes need pnpm-workspace.yaml in ${project.installRoot}.`);
	}
	const packageJsonOriginal = { path: project.packageJsonPath, source: project.packageJsonSource };
	const lockfileOriginals = await Promise.all(
		lockfiles.map(async (name) => {
			const path = resolve(project.installRoot, name);
			return { path, source: (await pathExists(path)) ? await readFile(path) : null };
		}),
	);
	const changed: { path: string; source: string | Buffer | null }[] = [];
	let installStarted = false;
	try {
		await writeFile(
			project.packageJsonPath,
			applyDependencyEdits(project.packageJsonSource, changes),
		);
		changed.push(packageJsonOriginal);
		if (workspaceManifest) {
			await writeFile(
				workspaceManifest.path,
				applyCatalogEdits(workspaceManifest.source, catalogEdits),
			);
			changed.push(workspaceManifest);
		}
		installStarted = true;
		changed.push(...lockfileOriginals);
		await run(install.command, install.args, project.installRoot);
		return await verify();
	} catch (error) {
		await restoreFiles(changed);
		if (!installStarted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		try {
			await run(install.command, install.args, project.installRoot);
		} catch {
			throw new Error(
				`${message} The dependency manifests and lockfile were restored, but reinstalling the previous dependencies failed. Run ${install.command} ${install.args.join(" ")} in ${project.installRoot}.`,
				{ cause: error },
			);
		}
		throw new Error(`${message} The previous dependencies were restored.`, { cause: error });
	}
}
