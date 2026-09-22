import { describe, expect, it } from "vitest";

import { multihashFromBlobCid, sha256Multihash } from "../src/multihash.js";

describe("sha256Multihash", () => {
	it("matches an independently-verified vector for sha2-256('hello world')", () => {
		// Cross-checked against the multiformats reference encoding:
		//   sha256("hello world")     = b94d27b9...e2efcde9
		//   multihash bytes           = 0x12 0x20 || digest
		//   multibase('b' = base32)   = bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i
		// If this drifts, the multibase prefix or the base32 alphabet changed.
		const out = sha256Multihash(new TextEncoder().encode("hello world"));
		expect(out).toBe("bciqlstjhxgju2pqiuuxffv62pwv7vree57rxuu4a52iir55m4lx432i");
	});
});

describe("multihashFromBlobCid", () => {
	it("extracts the sha2-256 multihash from a raw blob CID", () => {
		expect(
			multihashFromBlobCid("bafkreia6n3lf256wgzhov3k2orn2lreyllrloag5qxl467ycpppsssrt7q"),
		).toBe("bciqb43wwlv35mnso5lwvu5c3uxcjqwxcw4an3boxz57qe667fffdh7a");
	});

	it("rejects a non-raw CID", () => {
		expect(() =>
			multihashFromBlobCid("bafyreibm6jg3ux5qu5wzvikphw4qjzx6i7htc4w4e4c4pv7a7uynxqevmy"),
		).toThrow("CIDv1 raw sha2-256");
	});
});
