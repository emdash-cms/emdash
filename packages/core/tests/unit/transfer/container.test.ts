import { packTar, type TarEntry } from "modern-tar";
import { describe, expect, it } from "vitest";

import {
	packSitePackage,
	readSitePackageArchive,
	unpackSitePackage,
	type PackageFileSource,
} from "../../../src/transfer/container/tar.js";
import { TransferError } from "../../../src/transfer/errors.js";
import { MANIFEST_PATH } from "../../../src/transfer/format/paths.js";
import { buildGoldenPackage } from "../../utils/transfer/golden-package.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";

const encoder = new TextEncoder();
const SHA = "a".repeat(64);

async function goldenFiles(): Promise<PackageFileSource[]> {
	const storage = createMemoryStorage();
	const golden = await buildGoldenPackage(storage);
	const files: PackageFileSource[] = [];
	const paths = Array.from(storage.files.keys(), (key) => key.slice(golden.stage.prefix.length));
	const ordered = [MANIFEST_PATH, ...paths.filter((path) => path !== MANIFEST_PATH).toSorted()];
	for (const path of ordered) {
		const body = storage.files.get(golden.stage.keyFor(path))!.body;
		files.push({ path, bytes: body.byteLength, body: () => body });
	}
	return files;
}

async function toBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof TransferError ? error.code : String(error);
	}
	return undefined;
}

function file(name: string, body: string, extra: Partial<TarEntry["header"]> = {}): TarEntry {
	return { header: { name, size: encoder.encode(body).byteLength, type: "file", ...extra }, body };
}

describe("packSitePackage / unpackSitePackage", () => {
	it("round-trips every file of a package byte for byte", async () => {
		const files = await goldenFiles();
		const archive = await toBytes(packSitePackage(files));
		const unpacked = await readSitePackageArchive(archive);
		expect([...unpacked.keys()]).toEqual(files.map((f) => f.path));
		for (const source of files) {
			expect(unpacked.get(source.path)).toEqual(await source.body());
		}
	});

	it("produces identical bytes for identical input", async () => {
		const files = await goldenFiles();
		const first = await toBytes(packSitePackage(files));
		const second = await toBytes(packSitePackage(files));
		expect(second).toEqual(first);
	});

	it("streams entries to the callback and drains unread bodies", async () => {
		const files = await goldenFiles();
		const seen: string[] = [];
		const result = await unpackSitePackage(packSitePackage(files), async (entry) => {
			seen.push(entry.path);
			if (entry.parsed.type === "manifest") await new Response(entry.body).text();
		});
		expect(result.files).toBe(files.length);
		expect(seen).toEqual(files.map((f) => f.path));
	});

	it("refuses to pack a package that does not start with its manifest", async () => {
		const code = await codeOf(
			toBytes(
				packSitePackage([{ path: `media/${SHA}`, bytes: 1, body: () => encoder.encode("x") }]),
			),
		);
		expect(code).toBe("TRANSFER_CONTAINER_INVALID");
	});

	it("refuses to pack invalid paths, duplicates, and wrong sizes", async () => {
		const manifest = { path: MANIFEST_PATH, bytes: 2, body: () => encoder.encode("{}") };
		for (const files of [
			[manifest, { path: "../escape", bytes: 1, body: () => encoder.encode("x") }],
			[manifest, manifest],
			[manifest, { path: `media/${SHA}`, bytes: 5, body: () => encoder.encode("x") }],
			[{ ...manifest, bytes: 1 }],
		]) {
			expect(await codeOf(toBytes(packSitePackage(files)))).toBe("TRANSFER_CONTAINER_INVALID");
		}
	});
});

describe("unpackSitePackage rejects hostile archives", () => {
	async function unpackCode(entries: TarEntry[]): Promise<string | undefined> {
		const archive = await packTar(entries);
		return codeOf(readSitePackageArchive(archive));
	}

	it("rejects path traversal and absolute paths", async () => {
		expect(await unpackCode([file(MANIFEST_PATH, "{}"), file("../../etc/passwd", "x")])).toBe(
			"TRANSFER_CONTAINER_INVALID",
		);
		expect(
			await unpackCode([file(MANIFEST_PATH, "{}"), file("/records/entry/000000.ndjson", "x")]),
		).toBe("TRANSFER_CONTAINER_INVALID");
		expect(await unpackCode([file(MANIFEST_PATH, "{}"), file("records/entry/../../x", "x")])).toBe(
			"TRANSFER_CONTAINER_INVALID",
		);
	});

	it("rejects undeclared files", async () => {
		expect(await unpackCode([file(MANIFEST_PATH, "{}"), file("checksums.json", "{}")])).toBe(
			"TRANSFER_CONTAINER_INVALID",
		);
	});

	it("rejects duplicate entries", async () => {
		expect(
			await unpackCode([
				file(MANIFEST_PATH, "{}"),
				file(`media/${SHA}`, "a"),
				file(`media/${SHA}`, "b"),
			]),
		).toBe("TRANSFER_CONTAINER_INVALID");
		expect(await unpackCode([file(MANIFEST_PATH, "{}"), file(MANIFEST_PATH, "{}")])).toBe(
			"TRANSFER_CONTAINER_INVALID",
		);
	});

	it("rejects symlinks and hard links", async () => {
		expect(
			await unpackCode([
				file(MANIFEST_PATH, "{}"),
				{ header: { name: `media/${SHA}`, size: 0, type: "symlink", linkname: "/etc/passwd" } },
			]),
		).toBe("TRANSFER_CONTAINER_INVALID");
		expect(
			await unpackCode([
				file(MANIFEST_PATH, "{}"),
				{ header: { name: `media/${SHA}`, size: 0, type: "link", linkname: MANIFEST_PATH } },
			]),
		).toBe("TRANSFER_CONTAINER_INVALID");
	});

	it("rejects an archive whose first entry is not the manifest", async () => {
		expect(await unpackCode([file(`media/${SHA}`, "a"), file(MANIFEST_PATH, "{}")])).toBe(
			"TRANSFER_CONTAINER_INVALID",
		);
		expect(await unpackCode([])).toBe("TRANSFER_CONTAINER_INVALID");
	});

	it("rejects entries whose size differs from the declared size", async () => {
		const archive = await packTar([file(MANIFEST_PATH, "{}"), file(`media/${SHA}`, "abc")]);
		expect(
			await codeOf(
				readSitePackageArchive(archive, {
					expectedBytes: (path) => (path === `media/${SHA}` ? 4 : undefined),
				}),
			),
		).toBe("TRANSFER_CONTAINER_INVALID");
	});

	it("rejects a truncated archive", async () => {
		const archive = await packTar([
			file(MANIFEST_PATH, "{}"),
			file(`media/${SHA}`, "x".repeat(2000)),
		]);
		expect(await codeOf(readSitePackageArchive(archive.subarray(0, 1200)))).toBe(
			"TRANSFER_CONTAINER_INVALID",
		);
	});

	it("skips the package's own directory entries and a leading ./", async () => {
		const archive = await packTar([
			file(`./${MANIFEST_PATH}`, "{}"),
			{ header: { name: "records/", size: 0, type: "directory" } },
			{ header: { name: "records/entry/", size: 0, type: "directory" } },
			file("./records/entry/000000.ndjson", "x\n"),
		]);
		const files = await readSitePackageArchive(archive);
		expect([...files.keys()]).toEqual([MANIFEST_PATH, "records/entry/000000.ndjson"]);
	});

	it("rejects other directory entries", async () => {
		expect(
			await unpackCode([
				file(MANIFEST_PATH, "{}"),
				{ header: { name: "../evil/", size: 0, type: "directory" } },
			]),
		).toBe("TRANSFER_CONTAINER_INVALID");
	});
});

describe("unpackSitePackage callback handling", () => {
	it("propagates the callback's own error even when it holds the body's reader", async () => {
		const files = await goldenFiles();
		const failure = new Error("callback failed");
		await expect(
			unpackSitePackage(packSitePackage(files), async (entry) => {
				const reader = entry.body.getReader();
				await reader.read();
				throw failure;
			}),
		).rejects.toBe(failure);
	});

	it("skips unread bodies without reading them through", async () => {
		const archive = await packTar([
			file(MANIFEST_PATH, "{}"),
			file(`media/${SHA}`, "x".repeat(100_000)),
			file("records/entry/000000.ndjson", "y\n"),
		]);
		const seen: string[] = [];
		await unpackSitePackage(new Blob([archive]).stream(), async (entry) => {
			seen.push(entry.path);
		});
		expect(seen).toEqual([MANIFEST_PATH, `media/${SHA}`, "records/entry/000000.ndjson"]);
	});

	it("rejects a callback that leaves a body locked", async () => {
		const archive = await packTar([file(MANIFEST_PATH, "{}"), file(`media/${SHA}`, "abc")]);
		expect(
			await codeOf(
				unpackSitePackage(new Blob([archive]).stream(), async (entry) => {
					entry.body.getReader();
				}),
			),
		).toBe("TRANSFER_CONTAINER_INVALID");
	});
});
