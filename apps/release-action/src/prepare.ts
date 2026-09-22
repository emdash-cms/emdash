import { spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { MAX_BUNDLE_COMPRESSED_BYTES } from "@emdash-cms/registry-verification";
import {
	validatePluginBundle,
	type ValidatedPluginBundle,
} from "@emdash-cms/registry-verification/bundle";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";

const MAX_PROVENANCE_BYTES = 5 * 1024 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;

export class ReleasePreparationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReleasePreparationError";
	}
}

export interface PrepareReleaseFilesOptions {
	workspace: string;
	runnerTemp: string;
	bundleFile?: string;
	pluginDirectory?: string;
	provenanceFile: string;
	repository: string;
	workflowRef: string;
	repositoryVisibility: string;
}

export interface PreparedReleaseFiles {
	packageSlug: string;
	version: string;
	packageBytes: Uint8Array;
	packageChecksum: string;
	provenanceBytes: Uint8Array;
	provenanceChecksum: string;
	declaredAccess: ValidatedPluginBundle["declaredAccess"];
	sourceRepository: `${string}:${string}`;
	builderId: `${string}:${string}`;
}

export interface PrepareReleaseDependencies {
	bundlePlugin?: (options: {
		dir: string;
		outDir: string;
	}) => Promise<{ tarballPath: string | null }>;
	validateBundle?: (bytes: Uint8Array) => Promise<
		| {
				success: true;
				value: {
					packageSlug: string;
					version: string;
					declaredAccess: ValidatedPluginBundle["declaredAccess"];
				};
		  }
		| { success: false; code: string }
	>;
	computeChecksum?: (bytes: Uint8Array) => Promise<string>;
}

async function runBundleCommand(options: {
	dir: string;
	outDir: string;
}): Promise<{ tarballPath: string | null }> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(
			"pnpm",
			["exec", "emdash-plugin", "bundle", "--dir", options.dir, "--out-dir", options.outDir],
			{ cwd: options.dir, stdio: "inherit", shell: false },
		);
		child.once("error", () => reject(new ReleasePreparationError("Plugin build could not start")));
		child.once("exit", (code, signal) => {
			if (code === 0 && signal === null) resolvePromise();
			else reject(new ReleasePreparationError("Plugin build failed"));
		});
	});
	const outputDirectory = resolve(options.dir, options.outDir);
	const tarballs = (await readdir(outputDirectory))
		.filter((name) => name.endsWith(".tar.gz"))
		.map((name) => join(outputDirectory, name));
	if (tarballs.length !== 1) {
		throw new ReleasePreparationError("Plugin build did not produce exactly one bundle");
	}
	return { tarballPath: tarballs[0] ?? null };
}

async function trustedPath(root: string, candidate: string, label: string): Promise<string> {
	try {
		const trustedRoot = await realpath(root);
		const path = await realpath(resolve(trustedRoot, candidate));
		const rel = relative(trustedRoot, path);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new Error("outside root");
		const metadata = await stat(path);
		if (!metadata.isFile()) throw new Error("not a file");
		return path;
	} catch {
		throw new ReleasePreparationError(`${label} could not be read`);
	}
}

async function boundedFile(
	root: string,
	path: string,
	maximum: number,
	label: string,
): Promise<Uint8Array> {
	const trusted = await trustedPath(root, path, label);
	const metadata = await stat(trusted);
	if (metadata.size < 1 || metadata.size > maximum) {
		throw new ReleasePreparationError(`${label} is outside the supported size range`);
	}
	const bytes = await readFile(trusted);
	if (bytes.byteLength !== metadata.size || bytes.byteLength > maximum) {
		throw new ReleasePreparationError(`${label} changed while it was being read`);
	}
	return new Uint8Array(bytes);
}

async function checksum(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new ReleasePreparationError("Release checksum could not be computed");
	return result.value;
}

async function validateBundle(bytes: Uint8Array): Promise<
	| {
			success: true;
			value: {
				packageSlug: string;
				version: string;
				declaredAccess: ValidatedPluginBundle["declaredAccess"];
			};
	  }
	| { success: false; code: string }
> {
	const result = await validatePluginBundle(bytes);
	return result.success
		? {
				success: true,
				value: {
					packageSlug: result.value.manifest.id,
					version: result.value.manifest.version,
					declaredAccess: result.value.declaredAccess,
				},
			}
		: { success: false, code: result.error.code };
}

export async function prepareReleaseFiles(
	options: PrepareReleaseFilesOptions,
	dependencies: PrepareReleaseDependencies = {},
): Promise<PreparedReleaseFiles> {
	if (options.repositoryVisibility !== "public") {
		throw new ReleasePreparationError(
			"Automatic provenance is currently supported only for public GitHub repositories",
		);
	}
	if (
		!REPOSITORY_PATTERN.test(options.repository) ||
		!WORKFLOW_REF_PATTERN.test(options.workflowRef) ||
		!options.workflowRef.startsWith(`${options.repository}/.github/workflows/`)
	) {
		throw new ReleasePreparationError("GitHub repository or workflow identity is invalid");
	}
	let bundleFile = options.bundleFile;
	if (!bundleFile) {
		const pluginDirectory = await realpath(
			resolve(options.workspace, options.pluginDirectory ?? "."),
		).catch(() => {
			throw new ReleasePreparationError("Plugin directory could not be read");
		});
		const workspace = await realpath(options.workspace);
		const rel = relative(workspace, pluginDirectory);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
			throw new ReleasePreparationError("Plugin directory could not be read");
		}
		const bundled = await (dependencies.bundlePlugin ?? runBundleCommand)({
			dir: pluginDirectory,
			outDir: ".emdash-release",
		});
		if (!bundled.tarballPath) {
			throw new ReleasePreparationError("Plugin build did not produce a bundle");
		}
		bundleFile = bundled.tarballPath;
	}
	const [packageBytes, provenanceBytes] = await Promise.all([
		boundedFile(options.workspace, bundleFile, MAX_BUNDLE_COMPRESSED_BYTES, "Bundle file"),
		boundedFile(
			options.runnerTemp,
			options.provenanceFile,
			MAX_PROVENANCE_BYTES,
			"Provenance file",
		),
	]);
	const bundle = await (dependencies.validateBundle ?? validateBundle)(packageBytes);
	if (!bundle.success) {
		throw new ReleasePreparationError(`Plugin bundle is invalid (${bundle.code})`);
	}
	const computeChecksum = dependencies.computeChecksum ?? checksum;
	return {
		packageSlug: bundle.value.packageSlug,
		version: bundle.value.version,
		packageBytes,
		packageChecksum: await computeChecksum(packageBytes),
		provenanceBytes,
		provenanceChecksum: await computeChecksum(provenanceBytes),
		declaredAccess: bundle.value.declaredAccess,
		sourceRepository: `https://github.com/${options.repository}`,
		builderId: `https://github.com/${options.workflowRef}`,
	};
}
