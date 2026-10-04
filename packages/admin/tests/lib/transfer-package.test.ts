import { packTar } from "modern-tar";
import { describe, expect, it } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client.js";
import type {
	CreateImportResult,
	MissingFile,
	TransferOperation,
} from "../../src/lib/api/transfer.js";
import {
	EarlierImportWroteError,
	packageDigestOf,
	sha256Hex,
	SitePackageError,
	uploadSitePackage,
	type TransferUploadApi,
} from "../../src/lib/transfer-package.js";

const encoder = new TextEncoder();
const LIMITS = { manifestBytes: 8 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, maxBlobBytes: 1024 };

interface PackageFile {
	path: string;
	data: Uint8Array<ArrayBuffer>;
}

async function buildPackage(options: { mediaSize?: number } = {}) {
	const media = new Uint8Array(options.mediaSize ?? 32).fill(7);
	const mediaSha = await sha256Hex(media);
	const records = encoder.encode('{"id":"01","kind":"collection"}\n');
	const recordsSha = await sha256Hex(records);
	const index = encoder.encode(
		[
			JSON.stringify({ path: `media/${mediaSha}`, bytes: media.byteLength, sha256: mediaSha }),
			JSON.stringify({
				path: "records/collection/000000.ndjson",
				bytes: records.byteLength,
				sha256: recordsSha,
				records: 1,
			}),
		].join("\n") + "\n",
	);
	const indexSha = await sha256Hex(index);
	const manifest = encoder.encode(
		JSON.stringify({
			format: "emdash-site-package",
			index: [
				{ path: "index/000000.ndjson", bytes: index.byteLength, sha256: indexSha, entries: 2 },
			],
		}),
	);
	const files: PackageFile[] = [
		{ path: "manifest.json", data: manifest },
		{ path: "index/000000.ndjson", data: index },
		{ path: `media/${mediaSha}`, data: media },
		{ path: "records/collection/000000.ndjson", data: records },
	];
	return { files, manifest, index: { bytes: index.byteLength, sha256: indexSha } };
}

async function archive(files: PackageFile[], extra: Parameters<typeof packTar>[0] = []) {
	const bytes = await packTar([
		...files.map((file) => ({
			header: { name: file.path, size: file.data.byteLength, type: "file" as const },
			body: file.data,
		})),
		...extra,
	]);
	return new Blob([bytes as Uint8Array<ArrayBuffer>]);
}

function operation(
	state: TransferOperation["state"] = "uploading",
	overrides: Partial<TransferOperation> = {},
): TransferOperation {
	return {
		id: "op1",
		kind: "import",
		state,
		stage: null,
		cursor: null,
		progress: null,
		options: null,
		idempotencyKey: null,
		packageDigest: null,
		planDigest: null,
		originSiteId: null,
		receipt: null,
		errorCode: null,
		errorDetail: null,
		writeEpoch: 0,
		attemptCount: 0,
		leaseExpiresAt: null,
		runtimeGeneration: 1,
		cancelRequestedAt: null,
		mutationStartedAt: null,
		createdBy: "user1",
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		completedAt: null,
		expiresAt: null,
		stagingCollectedAt: null,
		...overrides,
	};
}

/**
 * A server double that follows the upload contract: creating the import
 * declares the index chunks, uploading an index chunk declares what it lists,
 * and `missing` lists every declared file not yet received.
 */
function fakeServer(
	options: {
		state?: TransferOperation["state"];
		failFirst?: number;
		/** Imports that already exist, by idempotency key. */
		existing?: Record<string, TransferOperation>;
	} = {},
) {
	const declared = new Map<string, MissingFile>();
	const received = new Map<string, Uint8Array>();
	const uploads: string[] = [];
	const keys: string[] = [];
	let createdWith: { key: string; manifest: string } | null = null;
	let failures = options.failFirst ?? 0;

	const api: TransferUploadApi = {
		async createImport(manifest, idempotencyKey): Promise<CreateImportResult> {
			keys.push(idempotencyKey);
			const existing = options.existing?.[idempotencyKey];
			if (existing) return { operation: existing, created: false, missing: { items: [] } };
			const text = new TextDecoder().decode(manifest);
			createdWith = { key: idempotencyKey, manifest: text };
			const parsed = JSON.parse(text) as { index: MissingFile[] };
			for (const ref of parsed.index) declared.set(ref.path, ref);
			return {
				operation: operation(options.state),
				created: true,
				missing: { items: [...declared.values()].filter((file) => !received.has(file.path)) },
			};
		},
		async listMissing() {
			return { items: [...declared.values()].filter((file) => !received.has(file.path)) };
		},
		async uploadFile(_id, path, body) {
			if (failures > 0) {
				failures--;
				throw new ApiResponseError(503, "TRANSFER_STORAGE_ERROR", "Try again");
			}
			const file = declared.get(path);
			if (!file) throw new ApiResponseError(404, "TRANSFER_FILE_NOT_DECLARED", "Not declared");
			uploads.push(path);
			received.set(path, body);
			if (path.startsWith("index/")) {
				for (const line of new TextDecoder().decode(body).split("\n")) {
					if (!line) continue;
					const entry = JSON.parse(line) as MissingFile;
					declared.set(entry.path, entry);
				}
			}
			return {};
		},
	};
	return { api, uploads, received, keys, created: () => createdWith };
}

describe("uploadSitePackage", () => {
	it("creates the import keyed by the package digest and uploads every file, index first", async () => {
		const pkg = await buildPackage();
		const server = fakeServer();
		const result = await uploadSitePackage({
			file: await archive(pkg.files),
			limits: LIMITS,
			api: server.api,
		});

		expect(result.id).toBe("op1");
		expect(server.created()?.key).toBe(await packageDigestOf(pkg.manifest));
		expect(server.uploads[0]).toBe("index/000000.ndjson");
		expect(server.uploads.toSorted()).toEqual(
			pkg.files
				.filter((file) => file.path !== "manifest.json")
				.map((file) => file.path)
				.toSorted(),
		);
	});

	it("skips files the server already has when the same package is chosen again", async () => {
		const pkg = await buildPackage();
		const server = fakeServer();
		const file = await archive(pkg.files);
		await uploadSitePackage({ file, limits: LIMITS, api: server.api });
		const firstUploads = server.uploads.length;

		await uploadSitePackage({
			file,
			limits: LIMITS,
			api: server.api,
			expectedPackageDigest: await packageDigestOf(pkg.manifest),
		});
		expect(server.uploads.length).toBe(firstUploads);
	});

	it("refuses a different package when resuming", async () => {
		const pkg = await buildPackage();
		const server = fakeServer();
		await expect(
			uploadSitePackage({
				file: await archive(pkg.files),
				limits: LIMITS,
				api: server.api,
				expectedPackageDigest: `sha256:${"0".repeat(64)}`,
			}),
		).rejects.toMatchObject({ reason: "different_package" });
		expect(server.created()).toBeNull();
	});

	it("retries transient upload failures", async () => {
		const pkg = await buildPackage();
		const server = fakeServer({ failFirst: 2 });
		await uploadSitePackage({
			file: await archive(pkg.files),
			limits: LIMITS,
			api: server.api,
			retryDelayMs: () => 0,
		});
		expect(server.received.size).toBe(3);
	});

	it("rejects a file whose bytes do not match the manifest before uploading it", async () => {
		const pkg = await buildPackage();
		const tampered = pkg.files.map((file) =>
			file.path.startsWith("records/")
				? { ...file, data: encoder.encode('{"id":"02","kind":"collection"}\n') }
				: file,
		);
		const server = fakeServer();
		const error = await uploadSitePackage({
			file: await archive(tampered),
			limits: LIMITS,
			api: server.api,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SitePackageError);
		expect(error).toMatchObject({ reason: "digest_mismatch" });
		expect(server.received.has("records/collection/000000.ndjson")).toBe(false);
	});

	it("rejects paths outside the package format", async () => {
		const pkg = await buildPackage();
		const server = fakeServer();
		await expect(
			uploadSitePackage({
				file: await archive(pkg.files, [
					{
						header: { name: "../escape.txt", size: 1, type: "file" },
						body: new Uint8Array([1]),
					},
				]),
				limits: LIMITS,
				api: server.api,
			}),
		).rejects.toMatchObject({ reason: "invalid_path" });
	});

	it("rejects an archive that does not start with the manifest", async () => {
		const pkg = await buildPackage();
		const server = fakeServer();
		await expect(
			uploadSitePackage({
				file: await archive([...pkg.files.slice(1), pkg.files[0]!]),
				limits: LIMITS,
				api: server.api,
			}),
		).rejects.toMatchObject({ reason: "manifest_first" });
		expect(server.created()).toBeNull();
	});

	it("rejects media larger than the site accepts", async () => {
		const pkg = await buildPackage({ mediaSize: LIMITS.maxBlobBytes + 1 });
		const server = fakeServer();
		await expect(
			uploadSitePackage({ file: await archive(pkg.files), limits: LIMITS, api: server.api }),
		).rejects.toMatchObject({ reason: "too_large" });
	});

	it("stops reading once the import is past uploading", async () => {
		const pkg = await buildPackage();
		const server = fakeServer({ state: "planned" });
		const result = await uploadSitePackage({
			file: await archive(pkg.files),
			limits: LIMITS,
			api: server.api,
		});
		expect(result.state).toBe("planned");
		expect(server.uploads).toEqual([]);
	});

	it.each(["failed", "cancelled", "expired", "abandoned"] as const)(
		"starts a new import when the earlier import of the same package %s before writing",
		async (state) => {
			const pkg = await buildPackage();
			const digest = await packageDigestOf(pkg.manifest);
			const server = fakeServer({ existing: { [digest]: operation(state, { id: "dead1" }) } });
			const result = await uploadSitePackage({
				file: await archive(pkg.files),
				limits: LIMITS,
				api: server.api,
			});

			expect(result.id).toBe("op1");
			expect(server.keys).toEqual([digest, `${digest}/dead1`]);
			expect(server.received.size).toBe(3);
		},
	);

	it("follows a chain of ended imports of the same package to a live one", async () => {
		const pkg = await buildPackage();
		const digest = await packageDigestOf(pkg.manifest);
		const server = fakeServer({
			existing: {
				[digest]: operation("cancelled", { id: "dead1" }),
				[`${digest}/dead1`]: operation("expired", { id: "dead2" }),
				[`${digest}/dead2`]: operation("uploading", { id: "live" }),
			},
		});
		const result = await uploadSitePackage({
			file: await archive(pkg.files),
			limits: LIMITS,
			api: server.api,
		});

		expect(result.id).toBe("live");
		expect(server.keys).toEqual([digest, `${digest}/dead1`, `${digest}/dead2`]);
	});

	it("refuses to start again when the earlier import wrote to the site before it stopped", async () => {
		const pkg = await buildPackage();
		const digest = await packageDigestOf(pkg.manifest);
		const dead = operation("failed", {
			id: "dead1",
			mutationStartedAt: "2026-09-01T00:05:00.000Z",
		});
		const server = fakeServer({ existing: { [digest]: dead } });
		const error = await uploadSitePackage({
			file: await archive(pkg.files),
			limits: LIMITS,
			api: server.api,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(EarlierImportWroteError);
		expect(error).toMatchObject({ operation: { id: "dead1" } });
		expect(server.keys).toEqual([digest]);
		expect(server.uploads).toEqual([]);
	});
});
