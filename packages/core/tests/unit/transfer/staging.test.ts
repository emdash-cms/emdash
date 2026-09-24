import { describe, expect, it } from "vitest";

import { TransferError } from "../../../src/transfer/errors.js";
import { canonicalJson } from "../../../src/transfer/format/canonical.js";
import { sha256Hex } from "../../../src/transfer/format/digest.js";
import { encodeChunk } from "../../../src/transfer/format/records.js";
import {
	isRefusedStorageKey,
	isTransferStorageKey,
	normalizeStorageKeyForGuard,
	stagingKey,
	stagingPrefix,
} from "../../../src/transfer/staging/keys.js";
import { StagedPackageReader, StagedPackageWriter } from "../../../src/transfer/staging/package.js";
import { putVerified, TransferStage } from "../../../src/transfer/staging/stage.js";
import { buildGoldenPackage } from "../../utils/transfer/golden-package.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";

const encoder = new TextEncoder();
const OPERATION = "01HZ0000000000000000000001";
const SECRET = "0123456789abcdef0123456789abcdef";

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(encoder.encode(part));
			controller.close();
		},
	});
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return error instanceof TransferError ? error.code : String(error);
	}
	return undefined;
}

describe("staging keys", () => {
	it("puts every operation under an unguessable prefix", () => {
		expect(stagingPrefix("import", OPERATION, SECRET)).toBe(
			`transfers/imports/${OPERATION}-${SECRET}/`,
		);
		expect(stagingPrefix("export", OPERATION, SECRET)).toBe(
			`transfers/exports/${OPERATION}-${SECRET}/`,
		);
		expect(() => stagingPrefix("import", "../x", SECRET)).toThrow(TransferError);
		expect(() => stagingPrefix("import", OPERATION, "short")).toThrow(TransferError);
	});

	it("only maps valid package paths to keys", () => {
		const prefix = stagingPrefix("import", OPERATION, SECRET);
		expect(stagingKey(prefix, "manifest.json")).toBe(`${prefix}manifest.json`);
		expect(() => stagingKey(prefix, "../../backups/x")).toThrow(TransferError);
	});

	it("recognizes staging keys case-insensitively", () => {
		expect(isTransferStorageKey("transfers/imports/x")).toBe(true);
		expect(isTransferStorageKey("Transfers/imports/x")).toBe(true);
		expect(isTransferStorageKey("media/transfers/x")).toBe(false);
	});
});

describe("putVerified", () => {
	it("stores a streamed body whose size and digest match", async () => {
		const storage = createMemoryStorage();
		await putVerified(storage, "k", streamOf("hel", "lo"), {
			bytes: 5,
			sha256: await sha256Hex("hello"),
		});
		expect(new TextDecoder().decode(storage.files.get("k")!.body)).toBe("hello");
	});

	it("deletes the object and fails when the body is longer than declared", async () => {
		const storage = createMemoryStorage();
		const code = await rejectionCode(
			putVerified(storage, "k", streamOf("hello", "!"), {
				bytes: 5,
				sha256: await sha256Hex("hello"),
			}),
		);
		expect(code).toBe("TRANSFER_FILE_SIZE_MISMATCH");
		expect(storage.files.has("k")).toBe(false);
	});

	it("deletes the object and fails when the body is shorter than declared", async () => {
		const storage = createMemoryStorage();
		const code = await rejectionCode(
			putVerified(storage, "k", streamOf("hell"), { bytes: 5, sha256: await sha256Hex("hello") }),
		);
		expect(code).toBe("TRANSFER_FILE_SIZE_MISMATCH");
		expect(storage.files.has("k")).toBe(false);
	});

	it("deletes the object and fails when the digest differs", async () => {
		const storage = createMemoryStorage();
		const code = await rejectionCode(
			putVerified(storage, "k", streamOf("jello"), { bytes: 5, sha256: await sha256Hex("hello") }),
		);
		expect(code).toBe("TRANSFER_FILE_DIGEST_MISMATCH");
		expect(storage.files.has("k")).toBe(false);
	});

	it("reports storage failures as storage errors", async () => {
		const storage = createMemoryStorage();
		storage.beforeUpload = () => {
			throw new Error("bucket unavailable");
		};
		const code = await rejectionCode(
			putVerified(storage, "k", encoder.encode("hello"), {
				bytes: 5,
				sha256: await sha256Hex("hello"),
			}),
		);
		expect(code).toBe("TRANSFER_STORAGE_ERROR");
	});
});

describe("StagedPackageReader", () => {
	it("verifies index chunks against the manifest", async () => {
		const storage = createMemoryStorage();
		const golden = await buildGoldenPackage(storage);
		const key = golden.stage.keyFor("index/000000.ndjson");
		const original = storage.files.get(key)!;
		storage.files.set(key, { ...original, body: original.body.toReversed() });
		const reader = new StagedPackageReader(golden.stage);
		expect(await rejectionCode(reader.indexChunk(0))).toBe("TRANSFER_FILE_DIGEST_MISMATCH");
	});

	it("rejects a chunk that fails strict validation, without leaking values", async () => {
		const storage = createMemoryStorage();
		const stage = new TransferStage(storage, "t/");
		const bad = encodeChunk(
			[
				canonicalJson({
					kind: "entry",
					id: "x",
					collection: "posts",
					locale: "en",
					fields: {},
					secret: "hunter2",
				}),
			],
			"records/entry/000000.ndjson",
		);
		await new StagedPackageWriter(stage).writeFile("records/entry/000000.ndjson", bad);
		try {
			await new StagedPackageReader(stage).readChunk("entry", 0);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(TransferError);
			expect((error as TransferError).code).toBe("TRANSFER_RECORD_INVALID");
			expect(JSON.stringify((error as TransferError).detail)).not.toContain("hunter2");
		}
	});

	it("rejects a chunk whose bytes differ from the index entry", async () => {
		const storage = createMemoryStorage();
		const golden = await buildGoldenPackage(storage);
		const expected = { bytes: 1, sha256: "0".repeat(64) };
		expect(await rejectionCode(golden.reader.readChunk("entry", 0, expected))).toBe(
			"TRANSFER_FILE_SIZE_MISMATCH",
		);
		const manifest = await golden.reader.manifest();
		const entry = (await golden.reader.indexChunk(0)).find(
			(file) => file.path === "records/entry/000000.ndjson",
		)!;
		expect(manifest.records.entry?.chunks).toBe(1);
		expect(
			await rejectionCode(
				golden.reader.readChunk("entry", 0, { bytes: entry.bytes, sha256: "0".repeat(64) }),
			),
		).toBe("TRANSFER_FILE_DIGEST_MISMATCH");
		expect(await golden.reader.readChunk("entry", 0, entry)).toHaveLength(6);
	});

	it("reports a missing staged file", async () => {
		const reader = new StagedPackageReader(new TransferStage(createMemoryStorage(), "t/"));
		expect(await rejectionCode(reader.manifest())).toBe("TRANSFER_FILE_MISSING");
	});

	it("rejects records written in the wrong chunk", async () => {
		const stage = new TransferStage(createMemoryStorage(), "t/");
		const writer = new StagedPackageWriter(stage);
		expect(
			await rejectionCode(
				writer.writeRecordChunk("entry", 0, [
					{ kind: "revision", id: "r", collection: "posts", entryId: "e", data: {} } as never,
				]),
			),
		).toBe("TRANSFER_RECORD_INVALID");
	});
});

describe("TransferStage", () => {
	it("collects staged objects in bounded batches", async () => {
		const storage = createMemoryStorage();
		const golden = await buildGoldenPackage(storage, { prefix: "transfers/imports/x/" });
		await storage.upload({
			key: "media/keep.jpg",
			body: encoder.encode("x"),
			contentType: "image/jpeg",
		});
		let deleted = 0;
		for (let round = 0; round < 100; round++) {
			const batch = await golden.stage.deleteSome(5);
			if (batch === 0) break;
			expect(batch).toBeLessThanOrEqual(5);
			deleted += batch;
		}
		expect(deleted).toBeGreaterThan(5);
		expect([...storage.files.keys()]).toEqual(["media/keep.jpg"]);
	});
});

describe("putVerified keepExistingOnFailure", () => {
	it("keeps the stored object when another upload already verified the path", async () => {
		const storage = createMemoryStorage();
		const sha256 = await sha256Hex("hello");
		await putVerified(storage, "k", encoder.encode("hello"), { bytes: 5, sha256 });
		const code = await rejectionCode(
			putVerified(
				storage,
				"k",
				streamOf("hello", "world"),
				{ bytes: 5, sha256 },
				{ keepExistingOnFailure: async () => true },
			),
		);
		expect(code).toBe("TRANSFER_FILE_SIZE_MISMATCH");
		expect(new TextDecoder().decode(storage.files.get("k")!.body)).toBe("hello");
	});

	it("deletes when the path is not verified", async () => {
		const storage = createMemoryStorage();
		await rejectionCode(
			putVerified(
				storage,
				"k",
				encoder.encode("jello"),
				{ bytes: 5, sha256: await sha256Hex("hello") },
				{ keepExistingOnFailure: async () => false },
			),
		);
		expect(storage.files.has("k")).toBe(false);
	});
});

describe("normalizeStorageKeyForGuard", () => {
	it("rejects keys that are not plain relative keys", () => {
		for (const key of [
			"/transfers/x",
			"\\transfers\\x",
			"transfers\\x",
			"./transfers/x",
			"x/../transfers/x",
			"a//b",
			"a/",
			"",
			"..",
		]) {
			expect(normalizeStorageKeyForGuard(key), key).toBeNull();
			expect(isTransferStorageKey(key), key).toBe(true);
			expect(isRefusedStorageKey(key), key).toBe(true);
		}
	});

	it("lowercases plain keys and refuses private prefixes", () => {
		expect(normalizeStorageKeyForGuard("Media/A.JPG")).toBe("media/a.jpg");
		expect(isRefusedStorageKey("BACKUPS/x.json")).toBe(true);
		expect(isRefusedStorageKey("Transfers/imports/x")).toBe(true);
		expect(isRefusedStorageKey("01HZ.jpg")).toBe(false);
		expect(isTransferStorageKey("backups/x")).toBe(false);
	});
});
