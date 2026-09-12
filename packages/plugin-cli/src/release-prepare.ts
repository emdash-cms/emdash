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

export type ReleasePrepareErrorCode =
	| "PACKAGE_AMBIGUOUS"
	| "PACKAGE_NOT_FOUND"
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
