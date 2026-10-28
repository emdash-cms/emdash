import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { imageSize } from "image-size";
// The UMD entry hides relative requires from the Action bundler.
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";

const MANIFEST_FILENAME = "emdash-plugin.jsonc";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_LANG_LENGTH = 64;
const MAX_SCREENSHOTS = 8;
const MAX_DIMENSION = 8192;
const PATH_SEPARATOR_PATTERN = /[\\/]+/;

export type PreparedReleaseImage = {
	bytes: Uint8Array;
	checksum: string;
	contentType: string;
	width: number;
	height: number;
	lang?: string;
};

export type PreparedReleaseMedia = {
	icon?: PreparedReleaseImage;
	banner?: PreparedReleaseImage;
	screenshots?: PreparedReleaseImage[];
};

export class ReleaseMediaPreparationError extends Error {
	override readonly name = "ReleaseMediaPreparationError";
}

export async function prepareReleaseMedia(options: {
	workspace: string;
	pluginDirectory: string;
	packageSlug: string;
	version: string;
	ignoreUnrelatedManifest?: boolean;
}): Promise<PreparedReleaseMedia> {
	const workspace = await directoryRealpath(options.workspace, "Workspace");
	const pluginDirectory = await directoryRealpath(
		resolve(workspace, options.pluginDirectory),
		"Plugin directory",
	);
	if (!within(workspace, pluginDirectory)) {
		throw new ReleaseMediaPreparationError("Plugin directory is outside the workspace");
	}

	const manifestPath = join(pluginDirectory, MANIFEST_FILENAME);
	let manifestBytes: Uint8Array;
	try {
		manifestBytes = await boundedFile(
			manifestPath,
			MAX_MANIFEST_BYTES,
			"Manifest",
			pluginDirectory,
		);
	} catch (error) {
		if (error instanceof MissingFileError) return {};
		throw error;
	}
	const manifest = parseManifest(manifestBytes);
	if (
		options.ignoreUnrelatedManifest &&
		isObject(manifest) &&
		manifest.slug !== options.packageSlug
	)
		return {};
	validateManifest(manifest, options.packageSlug, options.version);
	const artifacts = getArtifacts(manifest);
	const result: PreparedReleaseMedia = {};

	if (artifacts.icon !== undefined) {
		result.icon = await prepareImage(pluginDirectory, artifacts.icon, "Icon");
	}
	if (artifacts.banner !== undefined) {
		result.banner = await prepareImage(pluginDirectory, artifacts.banner, "Banner");
	}
	if (artifacts.screenshots !== undefined) {
		result.screenshots = [];
		for (const [index, image] of artifacts.screenshots.entries()) {
			result.screenshots.push(
				await prepareImage(pluginDirectory, image, `Screenshot ${index + 1}`),
			);
		}
	}
	return result;
}

class MissingFileError extends Error {}

type ArtifactDescriptor = { file: string; lang?: string };
type Manifest = Record<string, unknown>;

async function directoryRealpath(path: string, label: string): Promise<string> {
	try {
		const trusted = await realpath(path);
		if (!(await stat(trusted)).isDirectory()) throw new Error();
		return trusted;
	} catch {
		throw new ReleaseMediaPreparationError(`${label} could not be read`);
	}
}

function within(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function boundedFile(
	path: string,
	maximum: number,
	label: string,
	root?: string,
): Promise<Uint8Array> {
	let trusted: string;
	try {
		trusted = await realpath(path);
	} catch (error) {
		if (isNotFound(error)) throw new MissingFileError();
		throw new ReleaseMediaPreparationError(`${label} could not be read`);
	}
	try {
		if (root !== undefined && !within(root, trusted)) throw new Error();
		if (!(await stat(trusted)).isFile()) throw new Error();
		const handle = await open(trusted, "r");
		try {
			const buffer = Buffer.allocUnsafe(maximum + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead === 0) throw new Error("empty");
			if (bytesRead > maximum) throw new Error("large");
			return new Uint8Array(buffer.subarray(0, bytesRead));
		} finally {
			await handle.close();
		}
	} catch {
		throw new ReleaseMediaPreparationError(
			`${label} is missing, not a file, unreadable, or too large`,
		);
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseManifest(bytes: Uint8Array): unknown {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const valueErrors: ParseError[] = [];
	const value = parse(text, valueErrors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (valueErrors.length > 0) {
		throw new ReleaseMediaPreparationError("Manifest contains invalid JSONC");
	}
	return value;
}

function validateManifest(
	value: unknown,
	packageSlug: string,
	version: string,
): asserts value is Manifest {
	if (!isObject(value)) throw new ReleaseMediaPreparationError("Manifest must be an object");
	if (value.slug !== packageSlug)
		throw new ReleaseMediaPreparationError("Manifest slug does not match the bundle");
	if (value.version !== undefined && value.version !== version)
		throw new ReleaseMediaPreparationError("Manifest version does not match the bundle");
	if (value.release !== undefined && !isObject(value.release)) {
		throw new ReleaseMediaPreparationError("Manifest release must be an object");
	}
	if (
		isObject(value.release) &&
		value.release.artifacts !== undefined &&
		!isObject(value.release.artifacts)
	) {
		throw new ReleaseMediaPreparationError("Manifest release.artifacts must be an object");
	}
}

function getArtifacts(manifest: Manifest): {
	icon?: ArtifactDescriptor;
	banner?: ArtifactDescriptor;
	screenshots?: ArtifactDescriptor[];
} {
	const release = isObject(manifest.release) ? manifest.release : undefined;
	const artifacts = release && isObject(release.artifacts) ? release.artifacts : undefined;
	if (!artifacts) return {};
	for (const key of Object.keys(artifacts)) {
		if (key !== "icon" && key !== "banner" && key !== "screenshots") {
			throw new ReleaseMediaPreparationError(
				`Manifest release.artifacts has unsupported key ${key}`,
			);
		}
	}
	const result: ReturnType<typeof getArtifacts> = {};
	for (const key of ["icon", "banner"] as const) {
		if (artifacts[key] !== undefined) result[key] = descriptor(artifacts[key], key);
	}
	if (artifacts.screenshots !== undefined) {
		if (
			!Array.isArray(artifacts.screenshots) ||
			artifacts.screenshots.length < 1 ||
			artifacts.screenshots.length > MAX_SCREENSHOTS
		) {
			throw new ReleaseMediaPreparationError("Manifest screenshots must contain 1 to 8 images");
		}
		result.screenshots = artifacts.screenshots.map((item, index) =>
			descriptor(item, `screenshots[${index}]`),
		);
	}
	return result;
}

function descriptor(value: unknown, label: string): ArtifactDescriptor {
	if (!isObject(value))
		throw new ReleaseMediaPreparationError(`Manifest ${label} must be an object`);
	for (const key of Object.keys(value)) {
		if (key !== "file" && key !== "lang")
			throw new ReleaseMediaPreparationError(`Manifest ${label} has unsupported key ${key}`);
	}
	if (
		typeof value.file !== "string" ||
		value.file.length === 0 ||
		value.file.length > MAX_PATH_LENGTH
	) {
		throw new ReleaseMediaPreparationError(`Manifest ${label}.file is invalid`);
	}
	if (
		typeof value.lang === "string" &&
		(value.lang.length < 2 || value.lang.length > MAX_LANG_LENGTH)
	) {
		throw new ReleaseMediaPreparationError(`Manifest ${label}.lang is invalid`);
	}
	if (value.lang !== undefined && typeof value.lang !== "string") {
		throw new ReleaseMediaPreparationError(`Manifest ${label}.lang is invalid`);
	}
	return { file: value.file, ...(value.lang === undefined ? {} : { lang: value.lang }) };
}

async function prepareImage(
	root: string,
	input: ArtifactDescriptor,
	label: string,
): Promise<PreparedReleaseImage> {
	if (!safeRelativePath(input.file))
		throw new ReleaseMediaPreparationError(`${label} path is invalid`);
	const path = resolve(root, input.file);
	let trusted: string;
	try {
		trusted = await realpath(path);
	} catch {
		throw new ReleaseMediaPreparationError(`${label} could not be read`);
	}
	if (!within(root, trusted))
		throw new ReleaseMediaPreparationError(`${label} path is outside the plugin directory`);
	const bytes = await boundedFile(trusted, MAX_IMAGE_BYTES, label);
	let measured: { type?: string; width?: number; height?: number };
	try {
		measured = imageSize(bytes);
	} catch {
		throw new ReleaseMediaPreparationError(`${label} is not a readable PNG, JPEG, or WebP image`);
	}
	const contentType = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		webp: "image/webp",
	}[measured.type ?? ""];
	const width = measured.width;
	const height = measured.height;
	if (
		!contentType ||
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > MAX_DIMENSION ||
		height > MAX_DIMENSION
	) {
		throw new ReleaseMediaPreparationError(
			`${label} is not a supported image or has invalid dimensions`,
		);
	}
	const checksum = await computeMultihash(bytes);
	if (!checksum.success)
		throw new ReleaseMediaPreparationError(`${label} checksum could not be computed`);
	return {
		bytes,
		checksum: checksum.value,
		contentType,
		width,
		height,
		...(input.lang === undefined ? {} : { lang: input.lang }),
	};
}

function safeRelativePath(value: string): boolean {
	if (isAbsolute(value) || win32.isAbsolute(value)) return false;
	let depth = 0;
	for (const part of value.split(PATH_SEPARATOR_PATTERN)) {
		if (part === "" || part === ".") continue;
		if (part === ".." && depth-- === 0) return false;
		if (part !== "..") depth++;
	}
	return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
