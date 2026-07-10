import { describe, expect, it } from "vitest";

import { computeMultihash, fetchVerifiedResource } from "../../src/index.js";

const encoder = new TextEncoder();

describe("registry verification in workerd", () => {
	it("computes checksums and fetches through injected dependencies", async () => {
		const checksum = await computeMultihash(encoder.encode("hello"));
		expect(checksum).toEqual({
			success: true,
			value: "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja",
		});

		const resource = await fetchVerifiedResource("https://artifact.example.test/package.tgz", {
			fetch: async () => new Response(encoder.encode("artifact")),
			resolveHostname: async () => ["203.0.113.5"],
		});
		expect(resource).toMatchObject({ success: true, value: { status: 200 } });
		if (resource.success) expect(new TextDecoder().decode(resource.value.bytes)).toBe("artifact");
	});
});
