/**
 * `emdash site export`: drive a server-side export to completion, then
 * download its files one by one and assemble the `.emdash` package locally.
 *
 * A sidecar `<output>.partial.json` holds the idempotency key and operation
 * id, so re-running the same command after a crash or disconnect resumes the
 * same export instead of starting another. Downloaded files are kept in
 * `<output>.parts/` until the package is assembled, so a re-run only
 * downloads the files it does not have yet.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ulid } from "ulidx";
import { z } from "zod";

import type { EmDashClient, TransferOperation } from "../../client/index.js";
import { EmDashApiError } from "../../client/index.js";
import type { PackageFileSource } from "../../transfer/container/tar.js";
import { packageDigest, type Sha256Digest } from "../../transfer/format/digest.js";
import { parseManifest, type PackageFileEntry } from "../../transfer/format/manifest.js";
import { MANIFEST_PATH } from "../../transfer/format/paths.js";
import {
	diskFileMatches,
	openArchive,
	parseIndexChunk,
	saveVerifiedFile,
	writeSitePackage,
} from "./archive.js";
import {
	createProgressLogger,
	formatBytes,
	formatProgress,
	operationError,
	SiteTransferCliError,
	sleepFor,
	withRetry,
	type TransferRuntime,
} from "./shared.js";

const DOWNLOAD_CONCURRENCY = 4;

const sidecarSchema = z.object({
	version: z.literal(1),
	baseUrl: z.string(),
	comments: z.boolean(),
	idempotencyKey: z.string(),
	operationId: z.string().nullable(),
});

type Sidecar = z.infer<typeof sidecarSchema>;

export function exportSidecarPath(outputPath: string): string {
	return `${outputPath}.partial.json`;
}

async function readSidecar(path: string): Promise<Sidecar | null> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = sidecarSchema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function writeSidecar(path: string, sidecar: Sidecar): Promise<void> {
	await writeFile(path, `${JSON.stringify(sidecar, null, "\t")}\n`);
}

export interface SiteExportInput {
	client: EmDashClient;
	/** Instance URL; a sidecar left by an export from another site is ignored. */
	baseUrl: string;
	outputPath: string;
	comments: boolean;
}

export interface SiteExportResult {
	operationId: string;
	output: string;
	packageDigest: Sha256Digest;
	files: number;
	bytes: number;
	resumed: boolean;
}

async function startOrResume(
	input: SiteExportInput,
	runtime: TransferRuntime,
): Promise<{ operation: TransferOperation; resumed: boolean }> {
	const sidecarPath = exportSidecarPath(input.outputPath);
	let sidecar = await readSidecar(sidecarPath);
	if (sidecar && (sidecar.baseUrl !== input.baseUrl || sidecar.comments !== input.comments)) {
		runtime.reporter.warn(
			`Ignoring ${sidecarPath}: it belongs to an export with different options or from another site.`,
		);
		sidecar = null;
	}

	if (sidecar?.operationId) {
		const operationId = sidecar.operationId;
		const existing = await withRetry(runtime, "Reading the export", () =>
			input.client.transferExportGet(operationId),
		).catch((error: unknown) => {
			if (error instanceof EmDashApiError && error.code === "TRANSFER_OPERATION_NOT_FOUND") {
				return null;
			}
			throw error;
		});
		const operation = existing?.operation;
		if (operation && operation.state !== "failed" && operation.state !== "expired") {
			if (operation.state !== "complete" || operation.stagingCollectedAt === null) {
				runtime.reporter.info(`Resuming export ${operation.id}`);
				return { operation, resumed: true };
			}
		}
		runtime.reporter.warn(
			operation
				? `Export ${operation.id} ${operation.state === "failed" ? `failed (${operation.errorCode ?? "unknown error"})` : "expired"}; starting a new export.`
				: `Export ${operationId} no longer exists; starting a new export.`,
		);
		sidecar = null;
	}

	const state: Sidecar = sidecar ?? {
		version: 1,
		baseUrl: input.baseUrl,
		comments: input.comments,
		idempotencyKey: `emdash-cli-export-${ulid()}`,
		operationId: null,
	};
	await writeSidecar(sidecarPath, state);
	const created = await withRetry(runtime, "Starting the export", () =>
		input.client.transferExportCreate(input.comments ? {} : { comments: false }, {
			idempotencyKey: state.idempotencyKey,
		}),
	);
	await writeSidecar(sidecarPath, { ...state, operationId: created.operation.id });
	runtime.reporter.info(
		`${created.created ? "Started" : "Resuming"} export ${created.operation.id}`,
	);
	return { operation: created.operation, resumed: !created.created };
}

/** Advance an export until it ends; returns the complete operation. */
export async function driveExport(
	client: EmDashClient,
	operation: TransferOperation,
	runtime: TransferRuntime,
): Promise<TransferOperation> {
	const progress = createProgressLogger(runtime);
	let current = operation;
	while (current.state === "pending" || current.state === "running") {
		const step = await withRetry(runtime, "Export step", () =>
			client.transferExportAdvance(current.id),
		);
		current = step.operation;
		progress(`Exporting (${current.stage ?? current.state})`, formatProgress(current.progress));
		if (step.nextRequestInMs === null) break;
		await sleepFor(runtime, step.nextRequestInMs);
	}
	if (current.state !== "complete") throw operationError(current);
	return current;
}

/**
 * Directory next to the output where downloaded files are kept, by digest,
 * until the package is assembled. A re-run reuses every file there that
 * still verifies.
 */
export function exportPartsPath(outputPath: string): string {
	return `${outputPath}.parts`;
}

interface DownloadedFile {
	path: string;
	bytes: number;
	sha256: string;
}

/**
 * Run `task` over `items` with at most `limit` in flight. After a failure no
 * new item starts, the ones in flight finish, and the first failure is
 * thrown.
 */
async function forEachConcurrently<T>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	let failure: { error: unknown } | undefined;
	const worker = async () => {
		while (!failure && next < items.length) {
			const item = items[next++];
			try {
				await task(item);
			} catch (error) {
				failure ??= { error };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	if (failure) throw failure.error;
}

/**
 * Download a complete export file by file and write it as a package file.
 * The manifest must hash to the export's package digest.
 */
export async function downloadExport(
	client: EmDashClient,
	operation: TransferOperation,
	outputPath: string,
	runtime: TransferRuntime,
): Promise<{ packageDigest: Sha256Digest; files: number; bytes: number }> {
	const operationId = operation.id;
	const manifestBytes = await withRetry(runtime, "Downloading the manifest", () =>
		client.transferExportManifest(operationId),
	);
	const manifest = parseManifest(manifestBytes);
	const digest = await packageDigest(manifest);
	if (digest !== operation.packageDigest) {
		throw new SiteTransferCliError(
			"TRANSFER_PACKAGE_DIGEST_MISMATCH",
			`The downloaded manifest does not match export ${operationId}. Run the export again.`,
		);
	}
	const partsDir = exportPartsPath(outputPath);
	await mkdir(partsDir, { recursive: true });
	const partOf = (file: DownloadedFile) => join(partsDir, file.sha256);

	let kept = 0;
	const fetchPart = async (file: DownloadedFile): Promise<void> => {
		if (await diskFileMatches(partOf(file), file)) {
			kept++;
			return;
		}
		await withRetry(runtime, `Downloading ${file.path}`, async () => {
			const download = await client.transferExportFile(operationId, file.path);
			await saveVerifiedFile(file.path, download.body, file, partOf(file));
		});
	};

	const indexChunks: DownloadedFile[] = manifest.index.map((ref) => ({
		path: ref.path,
		bytes: ref.bytes,
		sha256: ref.sha256,
	}));
	const entries: PackageFileEntry[] = [];
	for (const chunk of indexChunks) {
		await fetchPart(chunk);
		entries.push(...parseIndexChunk(await readFile(partOf(chunk))));
	}

	const unique = [...new Map(entries.map((entry) => [entry.sha256, entry])).values()];
	const total = unique.reduce((sum, entry) => sum + entry.bytes, 0);
	const progress = createProgressLogger(runtime);
	let done = 0;
	let count = 0;
	await forEachConcurrently(unique, DOWNLOAD_CONCURRENCY, async (entry) => {
		await fetchPart(entry);
		done += entry.bytes;
		count++;
		progress(
			"Downloading",
			`${count}/${unique.length} files (${formatBytes(done)} / ${formatBytes(total)})`,
		);
	});
	if (kept > 0) runtime.reporter.info(`Reused ${kept} files downloaded by an earlier run`);

	async function* files(): AsyncGenerator<PackageFileSource> {
		yield { path: MANIFEST_PATH, bytes: manifestBytes.byteLength, body: () => manifestBytes };
		for (const file of [...indexChunks, ...entries]) {
			yield { path: file.path, bytes: file.bytes, body: () => openArchive(partOf(file)) };
		}
	}
	const written = await writeSitePackage(outputPath, files());
	await rm(partsDir, { recursive: true, force: true });
	return {
		packageDigest: digest,
		files: 1 + indexChunks.length + entries.length,
		bytes: written.bytes,
	};
}

export async function runSiteExport(
	input: SiteExportInput,
	runtime: TransferRuntime,
): Promise<SiteExportResult> {
	const { operation, resumed } = await startOrResume(input, runtime);
	const complete = await driveExport(input.client, operation, runtime);
	runtime.reporter.info(`Export ${complete.id} is complete; downloading`);
	const downloaded = await downloadExport(input.client, complete, input.outputPath, runtime);
	await rm(exportSidecarPath(input.outputPath), { force: true });
	return {
		operationId: complete.id,
		output: input.outputPath,
		packageDigest: downloaded.packageDigest,
		files: downloaded.files,
		bytes: downloaded.bytes,
		resumed,
	};
}
