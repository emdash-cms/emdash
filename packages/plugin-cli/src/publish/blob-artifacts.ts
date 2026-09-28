import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Blob } from "@atcute/lexicons";

import type { ManifestArtifacts, ManifestArtifactFile } from "../manifest/schema.js";
import type { ReleaseArtifactInput, ReleaseArtifactsInput } from "./api.js";
import { ArtifactError, buildArtifactRecord, measureImage } from "./artifacts.js";

const MAX_ARTIFACT_BYTES = 1024 * 1024;

export interface ResolveArtifactsOptions {
	artifacts: ManifestArtifacts | undefined;
	manifestDir: string;
	logger?: { info?(m: string): void; success?(m: string): void };
	upload: ArtifactUploader;
}

export type ArtifactUploader = (input: { bytes: Uint8Array; contentType: string }) => Promise<Blob>;

export class ArtifactUploadError extends Error {
	override readonly name = "ArtifactUploadError";
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export async function resolveReleaseArtifacts(
	options: ResolveArtifactsOptions,
): Promise<ReleaseArtifactsInput | undefined> {
	const { artifacts } = options;
	if (!artifacts) return undefined;
	if (!artifacts.icon && !artifacts.banner && !(artifacts.screenshots?.length ?? 0)) {
		return undefined;
	}

	const out: ReleaseArtifactsInput = {};
	if (artifacts.icon) {
		out.icon = await resolveOne(artifacts.icon, "icon", options);
	}
	if (artifacts.banner) {
		out.banner = await resolveOne(artifacts.banner, "banner", options);
	}
	if (artifacts.screenshots && artifacts.screenshots.length > 0) {
		const screenshots: ReleaseArtifactInput[] = [];
		for (const [index, ref] of artifacts.screenshots.entries()) {
			screenshots.push(await resolveOne(ref, `screenshot ${index + 1}`, options));
		}
		out.screenshots = screenshots;
	}
	return out;
}

async function resolveOne(
	ref: ManifestArtifactFile,
	label: string,
	options: ResolveArtifactsOptions,
): Promise<ReleaseArtifactInput> {
	const absolute = resolveWithinManifest(options.manifestDir, ref.file, label);
	let bytes: Uint8Array;
	try {
		bytes = await readFile(absolute);
	} catch (error) {
		throw new ArtifactUploadError(
			"ARTIFACT_FILE_UNREADABLE",
			`Could not read ${label} artifact at ${ref.file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (bytes.length > MAX_ARTIFACT_BYTES) {
		throw new ArtifactUploadError(
			"ARTIFACT_TOO_LARGE",
			`${label} artifact ${ref.file} is ${bytes.length} bytes, exceeding the ${MAX_ARTIFACT_BYTES}-byte limit.`,
		);
	}

	let measurement: ReturnType<typeof measureImage>;
	try {
		measurement = measureImage(bytes);
	} catch (error) {
		if (error instanceof ArtifactError) {
			throw new ArtifactUploadError(error.code, `${label} artifact: ${error.message}`);
		}
		throw error;
	}

	options.logger?.info?.(
		`Uploading ${label} (${measurement.width}x${measurement.height}) to the publisher PDS`,
	);
	let blob: Blob;
	try {
		blob = await options.upload({ bytes, contentType: measurement.contentType });
	} catch (error) {
		throw new ArtifactUploadError(
			"ARTIFACT_UPLOAD_FAILED",
			`Failed to upload ${label} artifact: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	try {
		const record = buildArtifactRecord({ bytes, blob, lang: ref.lang });
		options.logger?.success?.(`Uploaded ${label}`);
		return record;
	} catch (error) {
		if (error instanceof ArtifactError) {
			throw new ArtifactUploadError(error.code, `${label} artifact: ${error.message}`);
		}
		throw error;
	}
}

function resolveWithinManifest(manifestDir: string, file: string, label: string): string {
	const absolute = resolve(manifestDir, file);
	const rel = relative(manifestDir, absolute);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(file)) {
		throw new ArtifactUploadError(
			"ARTIFACT_PATH_ESCAPE",
			`${label} artifact path ${file} resolves outside the manifest directory.`,
		);
	}
	return absolute;
}
