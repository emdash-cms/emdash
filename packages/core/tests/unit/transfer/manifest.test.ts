import { describe, expect, it } from "vitest";

import { TransferError } from "../../../src/transfer/errors.js";
import { canonicalJson } from "../../../src/transfer/format/canonical.js";
import {
	packageFileEntrySchema,
	parseIndexLine,
	parseManifest,
	type SitePackageManifest,
} from "../../../src/transfer/format/manifest.js";
import {
	indexChunkPath,
	isPackagePath,
	mediaBlobPath,
	parsePackagePath,
	recordChunkPath,
} from "../../../src/transfer/format/paths.js";
import { buildGoldenPackage } from "../../utils/transfer/golden-package.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";

const SHA = "a".repeat(64);

async function goldenManifest(): Promise<SitePackageManifest> {
	return (await buildGoldenPackage(createMemoryStorage())).manifest;
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof TransferError ? error.code : "not-a-transfer-error";
	}
	return undefined;
}

describe("package paths", () => {
	it("accepts exactly the four path shapes", () => {
		expect(parsePackagePath("manifest.json")).toEqual({ type: "manifest", path: "manifest.json" });
		expect(parsePackagePath("index/000003.ndjson")).toMatchObject({ type: "index", seq: 3 });
		expect(parsePackagePath("records/menu_item/000012.ndjson")).toMatchObject({
			type: "records",
			kind: "menu_item",
			seq: 12,
		});
		expect(parsePackagePath(`media/${SHA}`)).toMatchObject({ type: "media", sha256: SHA });
	});

	it("rejects traversal, unknown kinds, case changes, and anything else", () => {
		for (const path of [
			"../manifest.json",
			"/manifest.json",
			"./manifest.json",
			"records/../manifest.json",
			"records/entry/../../x",
			"records/unknown/000000.ndjson",
			"records/entry/0.ndjson",
			"records/entry/0000001.ndjson",
			"Records/entry/000000.ndjson",
			`media/${SHA.toUpperCase()}`,
			`media/${SHA}.jpg`,
			"media\\x",
			"index/000000.json",
			"checksums.json",
			"",
		]) {
			expect(isPackagePath(path), path).toBe(false);
		}
	});

	it("builds paths", () => {
		expect(indexChunkPath(0)).toBe("index/000000.ndjson");
		expect(recordChunkPath("entry", 12)).toBe("records/entry/000012.ndjson");
		expect(mediaBlobPath(SHA)).toBe(`media/${SHA}`);
		expect(() => recordChunkPath("entry", 1_000_000)).toThrow(RangeError);
		expect(() => mediaBlobPath("nope")).toThrow(TypeError);
	});
});

describe("parseManifest", () => {
	it("accepts the golden manifest", async () => {
		const manifest = await goldenManifest();
		expect(parseManifest(canonicalJson(manifest))).toEqual(manifest);
	});

	it("rejects other formats and versions before strict validation", async () => {
		const manifest = await goldenManifest();
		expect(
			codeOf(() => parseManifest(canonicalJson({ ...manifest, formatVersion: "2", newField: 1 }))),
		).toBe("TRANSFER_UNSUPPORTED_FORMAT");
		expect(codeOf(() => parseManifest(canonicalJson({ ...manifest, format: "zip" })))).toBe(
			"TRANSFER_UNSUPPORTED_FORMAT",
		);
	});

	it("rejects unknown required features but tolerates unknown optional ones", async () => {
		const manifest = await goldenManifest();
		const features = [...manifest.features, "zz_future"].toSorted();
		expect(
			codeOf(() =>
				parseManifest(
					canonicalJson({
						...manifest,
						features,
						requiredFeatures: [...manifest.requiredFeatures, "zz_future"].toSorted(),
					}),
				),
			),
		).toBe("TRANSFER_UNSUPPORTED_FEATURE");
		expect(() => parseManifest(canonicalJson({ ...manifest, features }))).not.toThrow();
	});

	it("rejects non-canonical text, oversized manifests, and inconsistent content", async () => {
		const manifest = await goldenManifest();
		expect(codeOf(() => parseManifest(JSON.stringify(manifest, null, 2)))).toBe(
			"TRANSFER_MANIFEST_INVALID",
		);
		expect(codeOf(() => parseManifest(" ".repeat(9 * 1024 * 1024)))).toBe(
			"TRANSFER_LIMIT_EXCEEDED",
		);

		const invalid: Array<Partial<SitePackageManifest> & Record<string, unknown>> = [
			{ features: manifest.features.toReversed() },
			{ requiredFeatures: manifest.requiredFeatures.filter((feature) => feature !== "content") },
			{ records: { ...manifest.records, entry: { count: 5000, chunks: 1 } } },
			{
				features: manifest.features.filter((feature) => feature !== "comments"),
				requiredFeatures: manifest.requiredFeatures.filter((feature) => feature !== "comments"),
			},
			{ index: manifest.index.map((chunk) => ({ ...chunk, path: "index/000009.ndjson" })) },
			{ files: { ...manifest.files, count: manifest.files.count + 1 } },
			{ locales: { default: "de", used: ["en", "fr"] } },
			{ fence: { attempts: 4 } },
			{ surprise: true },
		];
		for (const patch of invalid) {
			expect(
				codeOf(() => parseManifest(canonicalJson({ ...manifest, ...patch }))),
				JSON.stringify(Object.keys(patch)),
			).toBe("TRANSFER_MANIFEST_INVALID");
		}
	});

	it("rejects a byte-order mark and invalid UTF-8", async () => {
		const manifest = await goldenManifest();
		const text = new TextEncoder().encode(canonicalJson(manifest));
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...text]);
		expect(codeOf(() => parseManifest(withBom))).toBe("TRANSFER_MANIFEST_INVALID");
		expect(codeOf(() => parseManifest(new Uint8Array([0x7b, 0xff, 0x7d])))).toBe(
			"TRANSFER_MANIFEST_INVALID",
		);
	});
});

describe("index entries", () => {
	it("require record counts on record chunks only and digest-named blobs", () => {
		expect(
			packageFileEntrySchema.safeParse({
				path: "records/entry/000000.ndjson",
				bytes: 10,
				sha256: SHA,
				records: 1,
			}).success,
		).toBe(true);
		expect(
			packageFileEntrySchema.safeParse({
				path: "records/entry/000000.ndjson",
				bytes: 10,
				sha256: SHA,
			}).success,
		).toBe(false);
		expect(
			packageFileEntrySchema.safeParse({ path: `media/${SHA}`, bytes: 10, sha256: SHA }).success,
		).toBe(true);
		expect(
			packageFileEntrySchema.safeParse({ path: `media/${SHA}`, bytes: 10, sha256: "b".repeat(64) })
				.success,
		).toBe(false);
		expect(
			packageFileEntrySchema.safeParse({ path: "manifest.json", bytes: 10, sha256: SHA }).success,
		).toBe(false);
		expect(
			packageFileEntrySchema.safeParse({ path: "index/000000.ndjson", bytes: 10, sha256: SHA })
				.success,
		).toBe(false);
	});

	it("never echoes manifest or index content in error details", async () => {
		const manifest = await goldenManifest();
		const failures = [
			() => parseManifest('{"format":"SENTINEL_d41c'),
			() => parseManifest(canonicalJson({ ...manifest, SENTINEL_d41c: 1 })),
			() =>
				parseManifest(
					canonicalJson({ ...manifest, records: { ...manifest.records, SENTINEL_d41c: {} } }),
				),
			() => parseManifest(canonicalJson({ ...manifest, originSiteId: { SENTINEL_d41c: 1 } })),
			() => parseIndexLine('{"SENTINEL_d41c'),
			() => parseIndexLine(canonicalJson({ path: "x", SENTINEL_d41c: 1 })),
		];
		for (const fail of failures) {
			let caught: unknown;
			try {
				fail();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TransferError);
			const { code, message, detail } = caught as TransferError;
			expect(JSON.stringify({ code, message, detail })).not.toContain("SENTINEL");
		}
	});

	it("parses canonical index lines only", () => {
		const entry = { bytes: 1, path: `media/${SHA}`, sha256: SHA };
		expect(parseIndexLine(canonicalJson(entry))).toEqual(entry);
		expect(
			codeOf(() => parseIndexLine(JSON.stringify({ path: entry.path, bytes: 1, sha256: SHA }))),
		).toBe("TRANSFER_MANIFEST_INVALID");
	});
});
