import { describe, expect, it } from "vitest";

import type { ValidatedReleaseView } from "../src/discovery/index.js";
import { registryLabelerPolicy } from "../src/listing-policy.js";
import { evaluateRegistryReleaseWithdrawal } from "../src/withdrawal.js";

const URI = "at://did:plc:publisher/com.emdashcms.experimental.package.release/gallery:1.0.0";
const CID = "bafyreig6yhf7b3q2jy5vsxawhsq7knfr5h5xj4vl7jrmqpm5m7agj2yp4u";

function release(labels: unknown[]): ValidatedReleaseView {
	return {
		uri: URI,
		cid: CID,
		did: "did:plc:publisher",
		package: "gallery",
		version: "1.0.0",
		artifactCaches: [],
		indexedAt: "2026-08-24T10:00:00.000Z",
		release: null,
		labels,
	} as ValidatedReleaseView;
}

function label(overrides: Record<string, unknown> = {}) {
	return {
		ver: 1,
		src: "did:plc:labeler",
		uri: URI,
		cid: CID,
		val: "security:yanked",
		cts: "2026-08-24T10:00:00.000Z",
		...overrides,
	};
}

describe("registry release withdrawal", () => {
	it.each(["security:yanked", "security-yanked"])("enforces %s through shared policy", (val) => {
		expect(
			evaluateRegistryReleaseWithdrawal(release([label({ val })]), registryLabelerPolicy(), {
				evaluatedAt: "2026-08-24T12:00:00.000Z",
			}).withdrawn,
		).toBe(true);
	});

	it("honors negation and exact CID applicability", () => {
		expect(
			evaluateRegistryReleaseWithdrawal(
				release([label(), label({ neg: true, cts: "2026-08-24T11:00:00.000Z" })]),
				registryLabelerPolicy(),
				{ evaluatedAt: "2026-08-24T12:00:00.000Z" },
			).withdrawn,
		).toBe(false);
		expect(
			evaluateRegistryReleaseWithdrawal(
				release([label({ cid: `bafyrei${"a".repeat(52)}` })]),
				registryLabelerPolicy(),
				{ evaluatedAt: "2026-08-24T12:00:00.000Z" },
			).withdrawn,
		).toBe(false);
	});

	it("uses the same explicit accepted sources as the request policy", () => {
		expect(
			evaluateRegistryReleaseWithdrawal(
				release([label()]),
				registryLabelerPolicy("did:plc:other;redact"),
				{ evaluatedAt: "2026-08-24T12:00:00.000Z" },
			).withdrawn,
		).toBe(false);
	});

	it("fails closed on a malformed hydrated label", () => {
		expect(
			evaluateRegistryReleaseWithdrawal(release([label({ ver: 2 })]), registryLabelerPolicy(), {
				evaluatedAt: "2026-08-24T12:00:00.000Z",
			}),
		).toMatchObject({ withdrawn: true, malformed: true });
	});
});
