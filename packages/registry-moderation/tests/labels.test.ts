import { describe, expect, it } from "vitest";

import { LISTING_LABELS, listingLabelKey, reduceListingLabels } from "../src/labels.js";
import type { ListingLabelEvent } from "../src/labels.js";

const URI = "at://did:plc:test/com.emdashcms.experimental.package.profile/plugin";

function label(overrides: Partial<ListingLabelEvent> = {}): ListingLabelEvent {
	return {
		ver: 1,
		src: "did:web:labeler.test",
		uri: URI,
		cid: "bafyold",
		val: LISTING_LABELS.passed,
		cts: "2026-08-24T00:00:00.000Z",
		...overrides,
	};
}

describe("listing label reduction", () => {
	it("keys standard label state by source, URI, and value rather than CID", () => {
		expect(listingLabelKey(label({ cid: "one" }))).toBe(listingLabelKey(label({ cid: "two" })));
	});

	it("retains the winning event CID for applicability", () => {
		const reduction = reduceListingLabels(
			[label({ cid: "bafyold" }), label({ cid: "bafynew", cts: "2026-08-24T00:00:01.000Z" })],
			"2026-08-24T00:00:02.000Z",
		);

		expect(reduction.states).toHaveLength(1);
		expect(reduction.states[0]?.winner.cid).toBe("bafynew");
		expect(reduction.states[0]?.active).toBe(true);
	});

	it("does not revive an older event after a winning negation or expiry", () => {
		const negated = reduceListingLabels(
			[
				label({ cid: "bafyold" }),
				label({ cid: "bafynew", neg: true, cts: "2026-08-24T00:00:01.000Z" }),
			],
			"2026-08-24T00:00:02.000Z",
		);
		const expired = reduceListingLabels(
			[
				label({ cid: "bafyold" }),
				label({
					cid: "bafynew",
					cts: "2026-08-24T00:00:01.000Z",
					exp: "2026-08-24T00:00:02.000Z",
				}),
			],
			"2026-08-24T00:00:02.000Z",
		);

		expect(negated.states[0]).toMatchObject({ active: false, winner: { cid: "bafynew" } });
		expect(expired.states[0]).toMatchObject({ active: false, winner: { cid: "bafynew" } });
	});

	it("fails closed when different events collide at the winning timestamp", () => {
		const reduction = reduceListingLabels(
			[label({ cid: "one" }), label({ cid: "two" })],
			"2026-08-24T00:00:02.000Z",
		);

		expect(reduction.states[0]?.active).toBe(false);
		expect(reduction.states[0]?.collision).toHaveLength(2);
	});
});
