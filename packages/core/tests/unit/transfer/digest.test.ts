import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../../src/transfer/format/canonical.js";
import {
	availableSha256Backends,
	chunkLogicalSha256,
	createHashingStream,
	createSha256,
	logicalDigest,
	packageDigest,
	receiptDigest,
	sha256Hex,
	type Sha256Backend,
} from "../../../src/transfer/format/digest.js";

const encoder = new TextEncoder();

const VECTORS: Array<[string, Uint8Array, string]> = [
	["empty", new Uint8Array(0), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	[
		"abc",
		encoder.encode("abc"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	],
	[
		"two-block message",
		encoder.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
		"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
	],
	[
		"one million a",
		encoder.encode("a".repeat(1_000_000)),
		"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
	],
];

/** Split into irregular chunks so incremental hashing crosses block boundaries. */
function chunked(bytes: Uint8Array): Uint8Array[] {
	const parts: Uint8Array[] = [];
	const sizes = [1, 63, 64, 65, 1000, 4096];
	for (let offset = 0, i = 0; offset < bytes.length; i++) {
		const size = sizes[i % sizes.length]!;
		parts.push(bytes.subarray(offset, offset + size));
		offset += size;
	}
	return parts;
}

describe("createSha256", () => {
	it("always offers the pure-JS fallback", async () => {
		expect(await availableSha256Backends()).toContain("oslo");
	});

	it("prefers node:crypto over the fallback on Node", async () => {
		const backends = await availableSha256Backends();
		expect(backends).toContain("node");
		expect((await createSha256()).backend).toBe(backends[0]);
	});

	it("every available backend matches the known vectors, one-shot and incremental", async () => {
		const backends: Sha256Backend[] = await availableSha256Backends();
		for (const backend of backends) {
			for (const [name, bytes, expected] of VECTORS) {
				const whole = await createSha256({ backend });
				whole.update(bytes);
				expect(await whole.digest(), `${backend} ${name}`).toBe(expected);

				const incremental = await createSha256({ backend });
				for (const part of chunked(bytes)) incremental.update(part);
				expect(await incremental.digest(), `${backend} ${name} incremental`).toBe(expected);
			}
		}
	});

	it("does not retain the caller's buffer", async () => {
		for (const backend of await availableSha256Backends()) {
			const hasher = await createSha256({ backend });
			const buffer = encoder.encode("abc");
			hasher.update(buffer);
			buffer.fill(0);
			expect(await hasher.digest()).toBe(VECTORS[1]![2]);
		}
	});

	it("rejects an unavailable backend", async () => {
		await expect(createSha256({ backend: "digest-stream" })).rejects.toThrow(/DigestStream/);
	});
});

describe("digests", () => {
	it("packageDigest is the sha256 of the canonical manifest", async () => {
		const manifest = { b: 1, a: [2] };
		expect(await packageDigest(manifest)).toBe(`sha256:${await sha256Hex('{"a":[2],"b":1}')}`);
	});

	it("receiptDigest ignores the receipt's own digest property", async () => {
		const receipt = { operationId: "op", counts: { entry: 1 } };
		const sealed = await receiptDigest(receipt);
		expect(await receiptDigest({ ...receipt, receiptDigest: sealed })).toBe(sealed);
		expect(await receiptDigest({ ...receipt, operationId: "other" })).not.toBe(sealed);
	});

	it("logical digests are two-level and order-sensitive", async () => {
		const a = await sha256Hex("a");
		const b = await sha256Hex("b");
		const chunk = await chunkLogicalSha256([
			["id1", a],
			["id2", b],
		]);
		expect(chunk).toBe(
			await sha256Hex(
				canonicalJson([
					["id1", a],
					["id2", b],
				]),
			),
		);
		expect(
			await chunkLogicalSha256([
				["id2", b],
				["id1", a],
			]),
		).not.toBe(chunk);
		expect(await logicalDigest([["entry", 0, chunk]])).toBe(
			`sha256:${await sha256Hex(canonicalJson([["entry", 0, chunk]]))}`,
		);
		await expect(chunkLogicalSha256([["id", "not-a-hash"]])).rejects.toThrow(TypeError);
	});
});

describe("createHashingStream", () => {
	it("hashes and counts what flows through", async () => {
		const hasher = await createSha256();
		const { stream, bytes } = createHashingStream(hasher);
		const output = await new Response(
			new Blob([encoder.encode("abc")]).stream().pipeThrough(stream),
		).text();
		expect(output).toBe("abc");
		expect(bytes()).toBe(3);
		expect(await hasher.digest()).toBe(VECTORS[1]![2]);
	});

	it("errors once more than maxBytes pass", async () => {
		const hasher = await createSha256();
		const { stream } = createHashingStream(hasher, {
			maxBytes: 2,
			onLimitExceeded: () => new Error("too big"),
		});
		await expect(
			new Response(new Blob([encoder.encode("abc")]).stream().pipeThrough(stream)).text(),
		).rejects.toThrow("too big");
	});
});
