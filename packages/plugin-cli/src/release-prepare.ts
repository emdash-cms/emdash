import { appendFile, lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { isDid, isHandle, type Handle } from "@atcute/lexicons/syntax";
import { isPluginSlug } from "@emdash-cms/plugin-types";
import { defineCommand } from "citty";
import consola from "consola";
import { parse, type ParseError } from "jsonc-parser";
import pc from "picocolors";

import { resolveSources } from "./build/pipeline.js";
import { bundlePlugin } from "./bundle/api.js";
import { MANIFEST_FILENAME } from "./manifest/load.js";
import { resolveHandleToDid } from "./manifest/publisher.js";

const SKIPPED_DIRECTORIES = new Set([".astro", ".emdash-release", ".git", "dist", "node_modules"]);
const MAX_DISCOVERED_DIRECTORIES = 10_000;
const MAX_DISCOVERED_PLUGINS = 256;
const MAX_PUBLISHED_PACKAGES_BYTES = 256 * 1024;

export type ReleasePrepareErrorCode =
	| "PACKAGE_AMBIGUOUS"
	| "PACKAGE_NOT_FOUND"
	| "PUBLISHED_PACKAGES_INVALID"
	| "PUBLISHER_UNRESOLVED"
	| "RELEASE_SELECTOR_INVALID"
	| "VERSION_MISMATCH";

export class ReleasePrepareError extends Error {
	override readonly name = "ReleasePrepareError";

	constructor(
		readonly code: ReleasePrepareErrorCode,
		message: string,
	) {
		super(message);
	}
}

export interface PreparedRepositoryRelease {
	packageSlug: string;
	version: string;
	pluginDirectory: string;
	publisherDid: string;
	bundleFile: string;
}

export interface PlannedRepositoryRelease {
	packageName: string;
	packageSlug: string;
	pluginDirectory: string;
	version: string;
}

interface ReleaseSelector {
	packageSlug: string;
	version: string | null;
}

function parseReleaseSelector(value: string): ReleaseSelector {
	const separator = value.lastIndexOf("@");
	const packageSlug = separator > 0 ? value.slice(0, separator) : value;
	const version = separator > 0 ? value.slice(separator + 1) : null;
	if (!isPluginSlug(packageSlug) || (version !== null && version.length === 0)) {
		throw new ReleasePrepareError(
			"RELEASE_SELECTOR_INVALID",
			"Release selector must be a plugin ID or an <id>@<version> package tag.",
		);
	}
	return { packageSlug, version };
}

export async function findRepositoryRoot(start: string): Promise<string> {
	let current = resolve(start);
	for (;;) {
		try {
			await lstat(join(current, ".git"));
			return current;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) return resolve(start);
		current = parent;
	}
}

async function discoverPluginDirectories(repositoryRoot: string): Promise<string[]> {
	const directories = [repositoryRoot];
	const plugins: string[] = [];
	let visited = 0;
	while (directories.length > 0) {
		const directory = directories.shift()!;
		visited += 1;
		if (visited > MAX_DISCOVERED_DIRECTORIES) {
			throw new ReleasePrepareError(
				"PACKAGE_AMBIGUOUS",
				"Repository contains too many directories to discover plugin packages safely.",
			);
		}
		const entries = await readdir(directory, { withFileTypes: true });
		if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILENAME)) {
			plugins.push(directory);
			if (plugins.length > MAX_DISCOVERED_PLUGINS) {
				throw new ReleasePrepareError(
					"PACKAGE_AMBIGUOUS",
					"Repository contains more than 256 plugin packages.",
				);
			}
		}
		for (const entry of entries) {
			if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
				directories.push(join(directory, entry.name));
			}
		}
	}
	return plugins;
}

interface PublishedPackage {
	name: string;
	version: string;
}

function parsePublishedPackages(value: string): PublishedPackage[] {
	if (value.length === 0 || value.length > MAX_PUBLISHED_PACKAGES_BYTES) {
		throw new ReleasePrepareError(
			"PUBLISHED_PACKAGES_INVALID",
			"Changesets published-packages output is invalid.",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ReleasePrepareError(
			"PUBLISHED_PACKAGES_INVALID",
			"Changesets published-packages output is not valid JSON.",
		);
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_DISCOVERED_PLUGINS) {
		throw new ReleasePrepareError(
			"PUBLISHED_PACKAGES_INVALID",
			"Changesets published-packages output must be a bounded array.",
		);
	}
	const packages: PublishedPackage[] = [];
	const names = new Set<string>();
	for (const item of parsed) {
		if (
			item === null ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			Object.keys(item).toSorted().join(",") !== "name,version"
		) {
			throw new ReleasePrepareError(
				"PUBLISHED_PACKAGES_INVALID",
				"Each Changesets published package must contain only name and version.",
			);
		}
		const name = Reflect.get(item, "name");
		const version = Reflect.get(item, "version");
		if (
			typeof name !== "string" ||
			name.length === 0 ||
			name.length > 214 ||
			typeof version !== "string" ||
			version.length === 0 ||
			version.length > 255 ||
			names.has(name)
		) {
			throw new ReleasePrepareError(
				"PUBLISHED_PACKAGES_INVALID",
				"Changesets published package names and versions must be unique bounded strings.",
			);
		}
		names.add(name);
		packages.push({ name, version });
	}
	return packages;
}

async function packageName(directory: string): Promise<string | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const name = Reflect.get(parsed, "name");
		return typeof name === "string" ? name : null;
	} catch {
		return null;
	}
}

function repositoryPath(repositoryRoot: string, path: string): string {
	return relative(repositoryRoot, path).split(sep).join("/");
}

export async function planPublishedRepositoryReleases(options: {
	repositoryRoot: string;
	publishedPackages: string;
}): Promise<PlannedRepositoryRelease[]> {
	const repositoryRoot = resolve(options.repositoryRoot);
	const published = parsePublishedPackages(options.publishedPackages);
	const publishedNames = new Set(published.map((item) => item.name));
	const directoriesByName = new Map<string, string[]>();
	for (const directory of await discoverPluginDirectories(repositoryRoot)) {
		const name = await packageName(directory);
		if (!name || !publishedNames.has(name)) continue;
		const directories = directoriesByName.get(name) ?? [];
		directories.push(directory);
		directoriesByName.set(name, directories);
	}
	const planned: PlannedRepositoryRelease[] = [];
	const slugs = new Set<string>();
	for (const item of published) {
		const directories = directoriesByName.get(item.name) ?? [];
		if (directories.length === 0) continue;
		if (directories.length > 1) {
			throw new ReleasePrepareError(
				"PACKAGE_AMBIGUOUS",
				`More than one EmDash plugin package uses the package name ${item.name}.`,
			);
		}
		const directory = directories[0]!;
		const sources = await resolveSources(directory);
		if (!sources.hasPackageJson || !sources.packageName) continue;
		if (sources.manifest.version !== item.version) {
			throw new ReleasePrepareError(
				"VERSION_MISMATCH",
				`Changesets reported ${item.name}@${item.version}, but ${sources.manifest.slug} is ${sources.manifest.version}.`,
			);
		}
		if (slugs.has(sources.manifest.slug)) {
			throw new ReleasePrepareError(
				"PACKAGE_AMBIGUOUS",
				`More than one ${sources.manifest.slug} plugin package was found in ${repositoryRoot}.`,
			);
		}
		slugs.add(sources.manifest.slug);
		planned.push({
			packageName: sources.packageName,
			packageSlug: sources.manifest.slug,
			pluginDirectory: repositoryPath(repositoryRoot, sources.pluginDir) || ".",
			version: item.version,
		});
	}
	return planned.toSorted((left, right) => left.packageSlug.localeCompare(right.packageSlug));
}

async function manifestSlug(directory: string): Promise<string | null> {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(
		await readFile(join(directory, MANIFEST_FILENAME), "utf8"),
		errors,
		{
			allowTrailingComma: true,
		},
	);
	if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const slug = Reflect.get(parsed, "slug");
	return typeof slug === "string" ? slug : null;
}

async function publisherDid(
	publisher: string | undefined,
	resolveHandle: (handle: Handle) => Promise<string>,
): Promise<string> {
	if (publisher && isDid(publisher)) return publisher;
	if (!publisher || !isHandle(publisher)) {
		throw new ReleasePrepareError(
			"PUBLISHER_UNRESOLVED",
			"The selected plugin has no valid publisher DID or handle.",
		);
	}
	let resolved: string;
	try {
		resolved = await resolveHandle(publisher);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ReleasePrepareError(
			"PUBLISHER_UNRESOLVED",
			`Could not resolve publisher handle ${publisher} to a DID: ${reason}`,
		);
	}
	if (!isDid(resolved)) {
		throw new ReleasePrepareError(
			"PUBLISHER_UNRESOLVED",
			`Publisher handle ${publisher} did not resolve to a valid DID.`,
		);
	}
	return resolved;
}

export async function prepareRepositoryRelease(options: {
	repositoryRoot: string;
	selector: string;
	outDir?: string;
	resolvePublisherDid?: (handle: Handle) => Promise<string>;
}): Promise<PreparedRepositoryRelease> {
	const repositoryRoot = resolve(options.repositoryRoot);
	const selector = parseReleaseSelector(options.selector);
	const directories = await discoverPluginDirectories(repositoryRoot);
	const candidates = await Promise.all(
		directories.map(async (directory) => ({ directory, slug: await manifestSlug(directory) })),
	);
	const matches = candidates.filter((candidate) => candidate.slug === selector.packageSlug);
	if (matches.length === 0) {
		throw new ReleasePrepareError(
			"PACKAGE_NOT_FOUND",
			`No ${MANIFEST_FILENAME} for ${selector.packageSlug} was found in ${repositoryRoot}.`,
		);
	}
	if (matches.length > 1) {
		throw new ReleasePrepareError(
			"PACKAGE_AMBIGUOUS",
			`More than one ${selector.packageSlug} plugin package was found in ${repositoryRoot}.`,
		);
	}
	const selected = await resolveSources(matches[0]!.directory);
	if (selector.version !== null && selected.manifest.version !== selector.version) {
		throw new ReleasePrepareError(
			"VERSION_MISMATCH",
			`Tag version ${selector.version} does not match ${selected.manifest.slug}@${selected.manifest.version}.`,
		);
	}
	const bundle = await bundlePlugin({
		dir: selected.pluginDir,
		outDir: resolve(repositoryRoot, options.outDir ?? ".emdash-release"),
	});
	if (!bundle.tarballPath) throw new Error("Plugin bundle was not created.");
	const relativePluginDirectory = relative(repositoryRoot, selected.pluginDir) || ".";
	const relativeBundleFile = relative(repositoryRoot, bundle.tarballPath);
	if (
		relativePluginDirectory === ".." ||
		relativePluginDirectory.startsWith(`..${sep}`) ||
		relativeBundleFile === ".." ||
		relativeBundleFile.startsWith(`..${sep}`)
	) {
		throw new ReleasePrepareError(
			"PACKAGE_NOT_FOUND",
			"Selected plugin is outside the repository.",
		);
	}
	return {
		packageSlug: selected.manifest.slug,
		version: selected.manifest.version,
		pluginDirectory: relativePluginDirectory,
		publisherDid: await publisherDid(
			selected.manifest.publisher,
			options.resolvePublisherDid ?? resolveHandleToDid,
		),
		bundleFile: relativeBundleFile,
	};
}

async function writeGitHubOutputs(path: string, release: PreparedRepositoryRelease): Promise<void> {
	const values = {
		"package-slug": release.packageSlug,
		version: release.version,
		"plugin-directory": release.pluginDirectory,
		"publisher-did": release.publisherDid,
		"bundle-file": release.bundleFile,
	};
	if (Object.values(values).some((value) => value.includes("\n") || value.includes("\r"))) {
		throw new ReleasePrepareError("RELEASE_SELECTOR_INVALID", "Release output is invalid.");
	}
	await appendFile(
		path,
		Object.entries(values)
			.map(([key, value]) => `${key}=${value}\n`)
			.join(""),
		"utf8",
	);
}

async function writeReleasePlan(path: string, selectors: readonly string[]): Promise<void> {
	await appendFile(path, `selectors=${JSON.stringify(selectors)}\n`, "utf8");
}

export const releasePlanCommand = defineCommand({
	meta: { name: "plan", description: "Plan repository plugin releases for GitHub Actions" },
	args: {
		dir: {
			type: "string",
			description: "Repository root (default: current repository)",
			default: process.cwd(),
		},
		"published-packages": {
			type: "string",
			description: "Changesets Action published-packages JSON output",
		},
		package: {
			type: "string",
			description: "Plugin ID or <id>@<version> for a manual release",
		},
	},
	async run({ args }) {
		try {
			if ((args["published-packages"] ? 1 : 0) + (args.package ? 1 : 0) !== 1) {
				throw new ReleasePrepareError(
					"RELEASE_SELECTOR_INVALID",
					"Pass exactly one of --published-packages or --package.",
				);
			}
			const repositoryRoot = await findRepositoryRoot(args.dir);
			let selectors: string[];
			if (args.package) {
				const selector = parseReleaseSelector(args.package);
				selectors = [`${selector.packageSlug}${selector.version ? `@${selector.version}` : ""}`];
			} else {
				selectors = (
					await planPublishedRepositoryReleases({
						repositoryRoot,
						publishedPackages: args["published-packages"]!,
					})
				).map((release) => `${release.packageSlug}@${release.version}`);
			}
			const output = process.env["GITHUB_OUTPUT"];
			if (output) await writeReleasePlan(output, selectors);
			consola.info(
				selectors.length === 0
					? "No published EmDash plugin packages found."
					: JSON.stringify(selectors),
			);
		} catch (error) {
			if (error instanceof ReleasePrepareError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}
	},
});

export const releasePrepareCommand = defineCommand({
	meta: { name: "prepare", description: "Prepare one repository package for GitHub Actions" },
	args: {
		selector: {
			type: "positional",
			description: "Plugin ID or <id>@<version> package tag",
			required: true,
		},
		dir: {
			type: "string",
			description: "Repository root (default: current repository)",
			default: process.cwd(),
		},
		"out-dir": {
			type: "string",
			description: "Repository-relative bundle output directory",
			default: ".emdash-release",
		},
	},
	async run({ args }) {
		try {
			const repositoryRoot = await findRepositoryRoot(args.dir);
			const release = await prepareRepositoryRelease({
				repositoryRoot,
				selector: args.selector,
				outDir: args["out-dir"],
			});
			const output = process.env["GITHUB_OUTPUT"];
			if (output) await writeGitHubOutputs(output, release);
			consola.success(`Prepared ${pc.cyan(`${release.packageSlug}@${release.version}`)}`);
			consola.info(`Bundle: ${release.bundleFile}`);
		} catch (error) {
			if (error instanceof ReleasePrepareError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}
	},
});
