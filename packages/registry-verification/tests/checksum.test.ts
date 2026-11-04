import { describe, expect, it } from "vitest";

import {
	compareDigestBytes,
	computeMultihash,
	decodeMultihash,
	verifyMultihash,
} from "../src/index.js";

const encoder = new TextEncoder();

describe("multihash checksums", () => {
	it("computes the sha2-256 multibase multihash known vector", async () => {
		// Independently fixed SHA-256 multihash vector for the UTF-8 bytes "hello".
		const result = await computeMultihash(encoder.encode("hello"));
		expect(result).toEqual({
			success: true,
			value: "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja",
		});
	});

	it("rejects malformed and unsupported multihashes", () => {
		expect(decodeMultihash("2cf24dba")).toMatchObject({
			success: false,
			error: { code: "INVALID_MULTIHASH" },
		});
		expect(
			decodeMultihash("bcmqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja"),
		).toMatchObject({
			success: false,
			error: { code: "UNSUPPORTED_MULTIHASH" },
		});
	});

	it("reports checksum mismatches", async () => {
		const expected = await computeMultihash(encoder.encode("expected"));
		if (!expected.success) throw new Error(expected.error.message);
		const result = await verifyMultihash(encoder.encode("actual"), expected.value);
		expect(result).toMatchObject({ success: false, error: { code: "CHECKSUM_MISMATCH" } });
	});

	it("compares public digest bytes without accepting length or byte mismatches", () => {
		expect(compareDigestBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
		expect(compareDigestBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
		expect(compareDigestBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
	});
});
