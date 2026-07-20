import { gzipSync } from "node:zlib";

import { packTar, type TarEntry, type TarHeader } from "modern-tar";
import { describe, expect, it } from "vitest";

import {
	MAX_BUNDLE_COMPRESSED_BYTES,
	MAX_BUNDLE_DECOMPRESSED_BYTES,
	MAX_BUNDLE_FILE_BYTES,
	MAX_BUNDLE_FILE_COUNT,
	MAX_BUNDLE_SIZE,
	MAX_BUNDLE_TAR_ENTRY_COUNT,
	validatePluginBundle,
} from "../src/index.js";
import type { VerificationErrorCode } from "../src/index.js";

const encoder = new TextEncoder();
const manifest = {
	id: "test-plugin",
	version: "1.0.0",
	capabilities: ["write:content"],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [],
	admin: {},
};

function file(name: string, body: string | Uint8Array): TarEntry {
	const bytes = typeof body === "string" ? encoder.encode(body) : body;
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

function directory(name: string): TarEntry {
	return { header: { name, size: 0, type: "directory" }, body: new Uint8Array() };
}

async function bundle(entries: TarEntry[]): Promise<Uint8Array> {
	return new Uint8Array(gzipSync(await packTar(entries)));
}

async function canonicalBundle(extra: TarEntry[] = []): Promise<Uint8Array> {
	return bundle([
		file("manifest.json", JSON.stringify(manifest)),
		file("backend.js", "export default {};"),
		...extra,
	]);
}

async function expectCode(bytes: Uint8Array, code: VerificationErrorCode): Promise<void> {
	const result = await validatePluginBundle(bytes);
	expect(result).toMatchObject({ success: false, error: { code } });
}

describe("validatePluginBundle", () => {
	it("returns the manifest, canonical access, backend, and optional admin", async () => {
		const result = await validatePluginBundle(
			await canonicalBundle([file("admin.js", "export default {};")]),
			{ expectedSlug: "test-plugin", expectedVersion: "1.0.0" },
		);
		expect(result).toMatchObject({
			success: true,
			value: {
				manifest: {
					id: "test-plugin",
					declaredAccess: { content: { read: {}, write: {} } },
					capabilities: ["write:content"],
				},
				declaredAccess: { content: { read: {}, write: {} } },
			},
		});
		if (result.success) {
			expect(new TextDecoder().decode(result.value.backend)).toBe("export default {};");
			expect(new TextDecoder().decode(result.value.admin)).toBe("export default {};");
		}
	});

	it("rejects expected slug and version mismatches", async () => {
		const bytes = await canonicalBundle();
		expect(await validatePluginBundle(bytes, { expectedSlug: "other" })).toMatchObject({
			success: false,
			error: { code: "BUNDLE_ID_MISMATCH" },
		});
		expect(await validatePluginBundle(bytes, { expectedVersion: "2.0.0" })).toMatchObject({
			success: false,
			error: { code: "BUNDLE_VERSION_MISMATCH" },
		});
	});

	it.each([
		"/manifest.json",
		"../manifest.json",
		"dir/../manifest.json",
		"dir\\manifest.json",
		"C:/manifest.json",
		"manifest.json/",
		"manifest.json\n",
	])("rejects unsafe path %s", async (name) => {
		await expectCode(
			await bundle([file(name, JSON.stringify(manifest)), file("backend.js", "x")]),
			"BUNDLE_INVALID_PATH",
		);
	});

	it("rejects NUL and malformed UTF-8 names", async () => {
		await expectCode(
			await bundle([
				file("manifest.json\0alias", JSON.stringify(manifest)),
				file("backend.js", "x"),
			]),
			"BUNDLE_INVALID_PATH",
		);
		const tar = await packTar([
			file("manifest.json", JSON.stringify(manifest)),
			file("backend.js", "x"),
		]);
		tar[0] = 0xff;
		await expectCode(new Uint8Array(gzipSync(tar)), "BUNDLE_INVALID_ARCHIVE");
	});

	it("rejects duplicate raw and normalized paths", async () => {
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", "x"),
			]),
			"BUNDLE_PATH_COLLISION",
		);
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("./manifest.json", JSON.stringify(manifest)),
				file("backend.js", "x"),
			]),
			"BUNDLE_PATH_COLLISION",
		);
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", "x"),
				file("./backend.js", "y"),
			]),
			"BUNDLE_PATH_COLLISION",
		);
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", "x"),
				file("caf\u00e9.js", "x"),
				file("cafe\u0301.js", "x"),
			]),
			"BUNDLE_PATH_COLLISION",
		);
	});

	it("rejects non-zero data after the tar end marker", async () => {
		const tar = await packTar([
			file("manifest.json", JSON.stringify(manifest)),
			file("backend.js", "x"),
		]);
		const ambiguous = new Uint8Array(tar.byteLength + 512);
		ambiguous.set(tar);
		ambiguous[tar.byteLength] = 1;
		await expectCode(new Uint8Array(gzipSync(ambiguous)), "BUNDLE_INVALID_ARCHIVE");
	});

	it.each([
		"link",
		"symlink",
		"character-device",
		"block-device",
		"fifo",
		"pax-header",
	] satisfies TarHeader["type"][])("rejects %s entries", async (type) => {
		await expectCode(
			await canonicalBundle([{ header: { name: "unsupported", size: 0, type } }]),
			"BUNDLE_UNSUPPORTED_ENTRY",
		);
	});

	it("accepts harmless directory entries without counting them as files", async () => {
		const directories: TarEntry[] = Array.from({ length: 10 }, (_, index) => ({
			header: { name: `dir-${index}/`, size: 0, type: "directory" },
		}));
		const result = await validatePluginBundle(await canonicalBundle(directories));
		expect(result.success).toBe(true);
	});

	it("requires root manifest.json and backend.js", async () => {
		await expectCode(
			await bundle([file("nested/manifest.json", "{}"), file("backend.js", "x")]),
			"BUNDLE_MISSING_MANIFEST",
		);
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("nested/backend.js", "x"),
			]),
			"BUNDLE_MISSING_BACKEND",
		);
	});

	it("rejects invalid gzip, invalid tar, malformed JSON, and schema-invalid manifests", async () => {
		await expectCode(encoder.encode("not gzip"), "BUNDLE_INVALID_ARCHIVE");
		const malformedTar = new Uint8Array(1024);
		malformedTar[0] = 1;
		await expectCode(new Uint8Array(gzipSync(malformedTar)), "BUNDLE_INVALID_ARCHIVE");
		await expectCode(
			await bundle([file("manifest.json", "{"), file("backend.js", "x")]),
			"BUNDLE_INVALID_MANIFEST",
		);
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify({ id: "test" })),
				file("backend.js", "x"),
			]),
			"BUNDLE_INVALID_MANIFEST",
		);
	});

	it("enforces compressed size at and over the boundary", async () => {
		await expectCode(new Uint8Array(MAX_BUNDLE_COMPRESSED_BYTES), "BUNDLE_INVALID_ARCHIVE");
		await expectCode(
			new Uint8Array(MAX_BUNDLE_COMPRESSED_BYTES + 1),
			"BUNDLE_COMPRESSED_SIZE_EXCEEDED",
		);
	});

	it("accepts per-file and aggregate file sizes at their boundaries", async () => {
		const manifestBytes = encoder.encode(JSON.stringify(manifest));
		const atFileLimit = await bundle([
			file("manifest.json", manifestBytes),
			file("backend.js", new Uint8Array(MAX_BUNDLE_FILE_BYTES)),
		]);
		expect((await validatePluginBundle(atFileLimit)).success).toBe(true);

		const atTotalLimit = await bundle([
			file("manifest.json", manifestBytes),
			file("backend.js", new Uint8Array(MAX_BUNDLE_FILE_BYTES)),
			file(
				"data.bin",
				new Uint8Array(MAX_BUNDLE_SIZE - MAX_BUNDLE_FILE_BYTES - manifestBytes.byteLength),
			),
		]);
		expect((await validatePluginBundle(atTotalLimit)).success).toBe(true);
	});

	it("accepts all file and tar entries at the aggregate size boundary", async () => {
		const manifestBytes = encoder.encode(JSON.stringify(manifest));
		const remainingFiles = Array.from({ length: MAX_BUNDLE_FILE_COUNT - 3 }, (_, index) =>
			file(`empty-${index}.bin`, new Uint8Array()),
		);
		const directories = Array.from(
			{ length: MAX_BUNDLE_TAR_ENTRY_COUNT - MAX_BUNDLE_FILE_COUNT },
			(_, index) => directory(`directory-${index}/`),
		);
		const bytes = await bundle([
			file("manifest.json", manifestBytes),
			file("backend.js", new Uint8Array(MAX_BUNDLE_FILE_BYTES)),
			file(
				"payload.bin",
				new Uint8Array(MAX_BUNDLE_SIZE - MAX_BUNDLE_FILE_BYTES - manifestBytes.byteLength),
			),
			...remainingFiles,
			...directories,
		]);

		expect((await validatePluginBundle(bytes)).success).toBe(true);
	});

	it("rejects per-file and aggregate file sizes over their boundaries", async () => {
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", new Uint8Array(MAX_BUNDLE_FILE_BYTES + 1)),
			]),
			"BUNDLE_FILE_SIZE_EXCEEDED",
		);
		await expectCode(
			await bundle([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", new Uint8Array(MAX_BUNDLE_FILE_BYTES)),
				file("data.bin", new Uint8Array(MAX_BUNDLE_FILE_BYTES)),
			]),
			"BUNDLE_DECOMPRESSED_SIZE_EXCEEDED",
		);
	});

	it("enforces file count at and over the boundary", async () => {
		const fillers = Array.from({ length: MAX_BUNDLE_FILE_COUNT - 2 }, (_, index) =>
			file(`file-${index}.js`, "x"),
		);
		expect((await validatePluginBundle(await canonicalBundle(fillers))).success).toBe(true);
		await expectCode(
			await canonicalBundle([...fillers, file("one-too-many.js", "x")]),
			"BUNDLE_FILE_COUNT_EXCEEDED",
		);
	});

	it("bounds decompressed collection before buffering a gzip bomb", async () => {
		const bomb = new Uint8Array(MAX_BUNDLE_DECOMPRESSED_BYTES + 1);
		await expectCode(new Uint8Array(gzipSync(bomb)), "BUNDLE_DECOMPRESSED_SIZE_EXCEEDED");
	});
});
