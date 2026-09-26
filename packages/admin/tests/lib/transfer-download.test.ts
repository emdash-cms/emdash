import { describe, expect, it } from "vitest";

import { packSitePackage, unpackSitePackage } from "../../../core/src/transfer/container/tar.js";
import { ApiResponseError } from "../../src/lib/api/client.js";
import { downloadSitePackage, type ExportDownloadApi } from "../../src/lib/transfer-download.js";
import { packageDigestOf, sha256Hex } from "../../src/lib/transfer-package.js";

const encoder = new TextEncoder();

interface PackageFile {
	path: string;
	data: Uint8Array<ArrayBuffer>;
}

/** A small export: one index chunk listing two media blobs and two record chunks. */
async function buildExport() {
	const mediaA = new Uint8Array(700).fill(3);
	const mediaB = new Uint8Array(300).fill(9);
	const shaA = await sha256Hex(mediaA);
	const shaB = await sha256Hex(mediaB);
	const collections = encoder.encode('{"id":"c1","kind":"collection"}\n');
	const entries = encoder.encode('{"id":"e1","kind":"entry"}\n');
	const listed = [
		{ path: `media/${shaA}`, data: mediaA },
		{ path: `media/${shaB}`, data: mediaB },
		{ path: "records/collection/000000.ndjson", data: collections },
		{ path: "records/entry/000000.ndjson", data: entries },
	].toSorted((a, b) => (a.path < b.path ? -1 : 1));
	const indexLines = await Promise.all(
		listed.map(async (file) =>
			JSON.stringify({
				path: file.path,
				bytes: file.data.byteLength,
				sha256: await sha256Hex(file.data),
			}),
		),
	);
	const index = encoder.encode(`${indexLines.join("\n")}\n`);
	const manifest = encoder.encode(
		JSON.stringify({
			files: { count: listed.length, totalBytes: 0 },
			format: "emdash-site-package",
			index: [
				{
					bytes: index.byteLength,
					entries: listed.length,
					path: "index/000000.ndjson",
					sha256: await sha256Hex(index),
				},
			],
		}),
	);
	const files: PackageFile[] = [
		{ path: "manifest.json", data: manifest },
		{ path: "index/000000.ndjson", data: index },
		...listed,
	];
	return { files, packageDigest: await packageDigestOf(manifest) };
}

function fakeServer(files: PackageFile[], options: { failFirst?: number; tamper?: string } = {}) {
	const byPath = new Map(files.map((file) => [file.path, file.data]));
	const requested: string[] = [];
	let failures = options.failFirst ?? 0;
	const api: ExportDownloadApi = {
		async fetchManifest() {
			return byPath.get("manifest.json")!;
		},
		async fetchFile(_id, path) {
			requested.push(path);
			if (failures > 0) {
				failures--;
				throw new ApiResponseError(503, "TRANSFER_STORAGE_ERROR", "Try again");
			}
			const data = byPath.get(path);
			if (!data) throw new ApiResponseError(404, "TRANSFER_FILE_NOT_DECLARED", "Not declared");
			if (path === options.tamper) {
				const copy = data.slice();
				copy[0] = (copy[0] ?? 0) ^ 0xff;
				return copy;
			}
			return data;
		},
	};
	return { api, requested };
}

function memorySink() {
	const chunks: Uint8Array[] = [];
	let aborted: unknown = null;
	const sink = new WritableStream<Uint8Array>({
		write(chunk) {
			chunks.push(chunk.slice());
		},
		abort(reason) {
			aborted = reason ?? true;
		},
	});
	return {
		sink,
		bytes: async () => new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()),
		aborted: () => aborted,
	};
}

async function readArchive(bytes: Uint8Array) {
	const entries: Array<{ path: string; data: Uint8Array }> = [];
	await unpackSitePackage(new Blob([bytes as BlobPart]).stream(), async (file) => {
		entries.push({
			path: file.path,
			data: new Uint8Array(await new Response(file.body).arrayBuffer()),
		});
	});
	return entries;
}

describe("downloadSitePackage", () => {
	it("writes the same archive the server's packer produces", async () => {
		const pkg = await buildExport();
		const server = fakeServer(pkg.files);
		const out = memorySink();
		const result = await downloadSitePackage({
			operationId: "exp1",
			packageDigest: pkg.packageDigest,
			sink: out.sink,
			api: server.api,
		});

		const downloaded = await out.bytes();
		const expected = new Uint8Array(
			await new Response(
				packSitePackage(
					pkg.files.map((file) => ({
						path: file.path,
						bytes: file.data.byteLength,
						body: () => file.data,
					})),
				),
			).arrayBuffer(),
		);
		expect(downloaded).toEqual(expected);
		expect(result).toEqual({ files: pkg.files.length, bytes: downloaded.byteLength });

		const entries = await readArchive(downloaded);
		expect(entries.map((entry) => entry.path)).toEqual(pkg.files.map((file) => file.path));
		for (const [index, entry] of entries.entries()) {
			expect(entry.data).toEqual(pkg.files[index]!.data);
		}
	});

	it("retries transient failures", async () => {
		const pkg = await buildExport();
		const server = fakeServer(pkg.files, { failFirst: 2 });
		const out = memorySink();
		await downloadSitePackage({
			operationId: "exp1",
			packageDigest: pkg.packageDigest,
			sink: out.sink,
			api: server.api,
			retryDelayMs: () => 0,
		});
		expect((await readArchive(await out.bytes())).length).toBe(pkg.files.length);
	});

	it("stops and aborts the output when a file does not match its digest", async () => {
		const pkg = await buildExport();
		const tampered = pkg.files[3]!.path;
		const server = fakeServer(pkg.files, { tamper: tampered });
		const out = memorySink();
		await expect(
			downloadSitePackage({
				operationId: "exp1",
				packageDigest: pkg.packageDigest,
				sink: out.sink,
				api: server.api,
				retryDelayMs: () => 0,
			}),
		).rejects.toMatchObject({ reason: "digest_mismatch", path: tampered });
		expect(server.requested.filter((path) => path === tampered)).toHaveLength(1);
		expect(out.aborted()).not.toBeNull();
	});

	it("refuses a manifest that is not the export's", async () => {
		const pkg = await buildExport();
		const server = fakeServer(pkg.files);
		const out = memorySink();
		await expect(
			downloadSitePackage({
				operationId: "exp1",
				packageDigest: `sha256:${"0".repeat(64)}`,
				sink: out.sink,
				api: server.api,
			}),
		).rejects.toMatchObject({ reason: "export_changed" });
		expect(server.requested).toEqual([]);
	});

	it("stops when cancelled", async () => {
		const pkg = await buildExport();
		const server = fakeServer(pkg.files);
		const controller = new AbortController();
		controller.abort(new DOMException("Stopped", "AbortError"));
		await expect(
			downloadSitePackage({
				operationId: "exp1",
				packageDigest: pkg.packageDigest,
				sink: memorySink().sink,
				api: server.api,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
