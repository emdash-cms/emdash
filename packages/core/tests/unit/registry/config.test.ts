import { describe, expect, it } from "vitest";

import { normalizeRegistryConfig } from "../../../src/registry/config.js";

describe("normalizeRegistryConfig", () => {
	it("rejects mutable handles in the minimum release age exemption list", () => {
		expect(() =>
			normalizeRegistryConfig({
				aggregatorUrl: "https://registry.example.com",
				policy: { minimumReleaseAgeExclude: ["publisher.example.com"] },
			}),
		).toThrow(/minimumReleaseAgeExclude entry must be a DID or <did>\/<slug>/);
	});

	it("normalizes DID and package exemptions", () => {
		expect(
			normalizeRegistryConfig({
				aggregatorUrl: "https://registry.example.com",
				policy: {
					minimumReleaseAgeExclude: ["DID:PLC:EXAMPLE", "DID:WEB:PUBLISHER.EXAMPLE/Gallery"],
				},
			}),
		).toMatchObject({
			policy: {
				minimumReleaseAgeExclude: ["did:plc:example", "did:web:publisher.example/gallery"],
			},
		});
	});
});
