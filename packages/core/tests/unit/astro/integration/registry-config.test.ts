import { describe, expect, it } from "vitest";

import emdash from "../../../../src/astro/integration/index.js";

describe("registry integration configuration", () => {
	it.each([
		["a malformed aggregator URL", { aggregatorUrl: "not a URL" }, "aggregatorUrl"],
		[
			"an insecure non-local aggregator",
			{ aggregatorUrl: "http://registry.example.com" },
			"aggregatorUrl",
		],
		[
			"an invalid minimum release age",
			{
				aggregatorUrl: "https://registry.example.com",
				policy: { minimumReleaseAge: "tomorrow" },
			},
			"minimumReleaseAge",
		],
	] as const)("fails during integration creation for %s", (_label, registry, field) => {
		expect(() => emdash({ experimental: { registry } })).toThrow(
			new RegExp(`EmDash registry configuration error.*${field}`),
		);
	});

	it("accepts shorthand and full registry configuration", () => {
		expect(() =>
			emdash({ experimental: { registry: "https://registry.example.com" } }),
		).not.toThrow();
		expect(() =>
			emdash({
				experimental: {
					registry: {
						aggregatorUrl: "https://registry.example.com/",
						acceptLabelers: "did:web:labeler.example",
						policy: { minimumReleaseAge: "48h" },
					},
				},
			}),
		).not.toThrow();
	});
});
