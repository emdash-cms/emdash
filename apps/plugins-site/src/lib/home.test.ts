import { describe, expect, it } from "vitest";

import { popularKeywords, type PackageSummary } from "./home.js";

describe("popular keywords", () => {
	it("merges case variants, counts each plugin once, and drops one-off keywords", () => {
		const keywords = popularKeywords(
			[
				{ did: "did:plc:a", profile: { keywords: ["SEO", "seo", "Forms"] } },
				{ did: "did:plc:b", profile: { keywords: [" seo ", "email"] } },
				{ did: "did:plc:c", profile: { keywords: ["Email", "forms"] } },
				{ did: "did:plc:d", profile: { keywords: ["email", "analytics"] } },
				{ did: "did:plc:e", profile: null },
			],
			10,
		);

		expect(keywords).toEqual(["email", "forms", "seo"]);
	});

	it("returns at most the requested number of keywords", () => {
		const packages = ["a", "b"].map(
			(id): PackageSummary => ({
				did: `did:plc:${id}`,
				profile: { keywords: ["seo", "forms", "email"] },
			}),
		);

		expect(popularKeywords(packages, 2)).toEqual(["email", "forms"]);
	});
});
