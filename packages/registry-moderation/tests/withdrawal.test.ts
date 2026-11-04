import { describe, expect, it } from "vitest";

import {
	evaluateHydratedReleaseWithdrawal,
	LEGACY_RELEASE_WITHDRAWAL_LABEL,
	RELEASE_WITHDRAWAL_LABEL,
	type ListingLabelEvent,
} from "../src/index.js";

const URI = "at://did:plc:publisher/com.emdashcms.experimental.package.release/gallery:1.0.0";
const CID = "bafyreig6yhf7b3q2jy5vsxawhsq7knfr5h5xj4vl7jrmqpm5m7agj2yp4u";
const SOURCE = "did:web:labels.example.com";
const NOW = "2026-08-24T12:00:00.000Z";

function label(overrides: Partial<ListingLabelEvent> = {}): ListingLabelEvent {
	return {
		ver: 1,
		src: SOURCE,
		uri: URI,
		cid: CID,
		val: RELEASE_WITHDRAWAL_LABEL,
		cts: "2026-08-24T10:00:00.000Z",
		...overrides,
	};
}

function evaluate(labels: ListingLabelEvent[], acceptedSources?: string[]) {
	return evaluateHydratedReleaseWithdrawal({
		uri: URI,
		cid: CID,
		labels,
		evaluatedAt: NOW,
		acceptedSources,
	});
}

describe("release withdrawal", () => {
	it.each([LEGACY_RELEASE_WITHDRAWAL_LABEL, RELEASE_WITHDRAWAL_LABEL])("recognizes %s", (value) => {
		expect(evaluate([label({ val: value })]).withdrawn).toBe(true);
	});

	it("honors current negation, expiry, CID, and accepted source", () => {
		expect(
			evaluate([label(), label({ neg: true, cts: "2026-08-24T11:00:00.000Z" })]).withdrawn,
		).toBe(false);
		expect(evaluate([label({ exp: NOW })]).withdrawn).toBe(false);
		expect(
			evaluate([label({ cid: "bafyreihf4k3kf5j7dmvclqmk3ypfopgcrf5jm5k4mls3tcbnkj2xszc3da" })])
				.withdrawn,
		).toBe(false);
		expect(evaluate([label()], ["did:web:other.example.com"]).withdrawn).toBe(false);
	});

	it("fails closed on a same-time positive and negation collision", () => {
		expect(evaluate([label(), label({ neg: true })]).withdrawn).toBe(true);
	});

	it("does not withdraw on a collision containing only inactive events", () => {
		expect(
			evaluate([label({ neg: true }), label({ neg: true, exp: "2026-08-25T00:00:00.000Z" })])
				.withdrawn,
		).toBe(false);
		expect(
			evaluate([label({ exp: "2026-08-24T11:00:00.000Z" }), label({ exp: NOW })]).withdrawn,
		).toBe(false);
	});
});
