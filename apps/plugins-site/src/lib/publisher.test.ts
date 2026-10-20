import { describe, expect, it } from "vitest";

import { identityParts, publisherSummary } from "./publisher.js";

const now = new Date("2026-10-16T12:00:00Z");

describe("publisher summary", () => {
	it("uses the earliest listing and the latest update across plugins", () => {
		const summary = publisherSummary(
			[
				{ indexedAt: "2026-10-01T00:00:00Z", profile: { lastUpdated: "2026-10-07T09:00:00Z" } },
				{ indexedAt: "2026-09-12T00:00:00Z", profile: { lastUpdated: "2026-10-15T09:00:00Z" } },
				{ indexedAt: "2026-09-30T00:00:00Z", profile: null },
			],
			now,
		);

		expect(summary).toEqual({
			count: 3,
			countLabel: "3 plugins",
			listedSince: { datetime: "2026-09", label: "Sep 2026" },
			lastUpdated: { datetime: "2026-10-15T09:00:00Z", label: "yesterday" },
		});
	});

	it("skips unparseable dates and omits what it cannot work out", () => {
		const summary = publisherSummary(
			[{ indexedAt: "not a date", profile: { lastUpdated: "soon" } }],
			now,
		);

		expect(summary).toEqual({
			count: 1,
			countLabel: "1 plugin",
			listedSince: undefined,
			lastUpdated: undefined,
		});
	});
});

describe("identity parts", () => {
	it("breaks a handle after each dot and a DID after each colon", () => {
		expect(identityParts("@desidashlab.bsky.social")).toEqual(["@desidashlab.", "bsky.", "social"]);
		expect(identityParts("did:plc:abc123")).toEqual(["did:", "plc:", "abc123"]);
	});

	it("keeps the text intact", () => {
		for (const identity of ["@a..b", ".lead", "plain", "trailing."]) {
			expect(identityParts(identity).join("")).toBe(identity);
		}
	});
});
