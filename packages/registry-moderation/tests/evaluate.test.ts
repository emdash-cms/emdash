import { describe, expect, it } from "vitest";

import {
	evaluateHydratedListingVisibility,
	evaluateListingVisibility,
	selectLatestHydratedApprovedRevision,
} from "../src/evaluate.js";
import {
	FIXTURE_LABELER_DID,
	FIXTURE_NEW_PROFILE_CID,
	FIXTURE_PROFILE_CID,
	FIXTURE_PROFILE_URI,
	FIXTURE_PUBLISHER_DID,
	INITIAL_LISTING_POLICY_FIXTURE,
	LABEL_TRANSITION_RULES_FIXTURE,
	LISTING_TRANSITION_FIXTURES,
} from "../src/fixtures/index.js";
import { LISTING_LABELS, type ListingLabelEvent } from "../src/labels.js";

const NOW = "2026-08-24T01:00:00.000Z";

describe("listing visibility", () => {
	it.each(LISTING_TRANSITION_FIXTURES)("applies the $id contract", (fixture) => {
		const result = evaluateHydratedListingVisibility({
			subject: fixture.subject,
			policy: INITIAL_LISTING_POLICY_FIXTURE,
			labels: fixture.labels,
			evaluatedAt: NOW,
		});

		expect(result.state).toBe(fixture.expectedState);
		expect(result.visible).toBe(fixture.expectedState === "passed");
	});

	it("freezes transitions for every listing label and operator authority", () => {
		const issued = new Set(
			LABEL_TRANSITION_RULES_FIXTURE.flatMap((transition) => transition.issues),
		);
		for (const value of Object.values(LISTING_LABELS)) {
			expect(issued.has(value)).toBe(true);
		}
		expect(LABEL_TRANSITION_RULES_FIXTURE).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ actor: "reviewer", action: "approve" }),
				expect.objectContaining({ actor: "reviewer", action: "block" }),
				expect.objectContaining({ actor: "admin", action: "takedown" }),
			]),
		);
	});

	it("ignores a positive label from a source that is not required", () => {
		const result = evaluateHydratedListingVisibility({
			subject: {
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_PROFILE_CID,
				kind: "profile",
				publisherDid: FIXTURE_PUBLISHER_DID,
			},
			policy: INITIAL_LISTING_POLICY_FIXTURE,
			labels: [
				{
					ver: 1,
					src: "did:web:untrusted.test",
					uri: FIXTURE_PROFILE_URI,
					cid: FIXTURE_PROFILE_CID,
					val: LISTING_LABELS.passed,
					cts: "2026-08-24T00:00:00.000Z",
				},
			],
			evaluatedAt: NOW,
		});

		expect(result).toMatchObject({
			visible: false,
			state: "unavailable",
			missingPositiveSources: [FIXTURE_LABELER_DID],
		});
	});

	it("selects the previous approved revision while a newer revision is pending", () => {
		const pass: ListingLabelEvent = {
			ver: 1,
			src: FIXTURE_LABELER_DID,
			uri: FIXTURE_PROFILE_URI,
			cid: FIXTURE_PROFILE_CID,
			val: LISTING_LABELS.passed,
			cts: "2026-08-24T00:00:00.000Z",
		};
		const pending: ListingLabelEvent = {
			...pass,
			cid: FIXTURE_NEW_PROFILE_CID,
			val: LISTING_LABELS.pending,
			cts: "2026-08-24T00:00:01.000Z",
		};
		const selected = selectLatestHydratedApprovedRevision({
			revisions: [
				{
					uri: FIXTURE_PROFILE_URI,
					cid: FIXTURE_PROFILE_CID,
					kind: "profile",
					publisherDid: FIXTURE_PUBLISHER_DID,
					observedAt: "2026-08-23T00:00:00.000Z",
				},
				{
					uri: FIXTURE_PROFILE_URI,
					cid: FIXTURE_NEW_PROFILE_CID,
					kind: "profile",
					publisherDid: FIXTURE_PUBLISHER_DID,
					observedAt: "2026-08-24T00:00:00.000Z",
				},
			],
			policy: INITIAL_LISTING_POLICY_FIXTURE,
			labels: [pass, pending],
			evaluatedAt: NOW,
		});

		expect(selected?.cid).toBe(FIXTURE_PROFILE_CID);
	});

	it("does not revive the historical pass after a newer pass is negated", () => {
		const labels: ListingLabelEvent[] = [
			{
				ver: 1,
				src: FIXTURE_LABELER_DID,
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_PROFILE_CID,
				val: LISTING_LABELS.passed,
				cts: "2026-08-24T00:00:00.000Z",
			},
			{
				ver: 1,
				src: FIXTURE_LABELER_DID,
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_NEW_PROFILE_CID,
				val: LISTING_LABELS.passed,
				cts: "2026-08-24T00:00:01.000Z",
			},
			{
				ver: 1,
				src: FIXTURE_LABELER_DID,
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_NEW_PROFILE_CID,
				val: LISTING_LABELS.passed,
				neg: true,
				cts: "2026-08-24T00:00:02.000Z",
			},
		];

		for (const cid of [FIXTURE_PROFILE_CID, FIXTURE_NEW_PROFILE_CID]) {
			expect(
				evaluateHydratedListingVisibility({
					subject: {
						uri: FIXTURE_PROFILE_URI,
						cid,
						kind: "profile",
						publisherDid: FIXTURE_PUBLISHER_DID,
					},
					policy: INITIAL_LISTING_POLICY_FIXTURE,
					labels,
					evaluatedAt: NOW,
				}).visible,
			).toBe(false);
		}
	});

	it("applies exact-CID blocks before a colliding label state", () => {
		const block: ListingLabelEvent = {
			ver: 1,
			src: FIXTURE_LABELER_DID,
			uri: FIXTURE_PROFILE_URI,
			cid: FIXTURE_PROFILE_CID,
			val: LISTING_LABELS.blocked,
			cts: "2026-08-24T00:00:00.000Z",
		};
		const result = evaluateHydratedListingVisibility({
			subject: {
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_PROFILE_CID,
				kind: "profile",
				publisherDid: FIXTURE_PUBLISHER_DID,
			},
			policy: INITIAL_LISTING_POLICY_FIXTURE,
			labels: [block, { ...block, neg: true }],
			evaluatedAt: NOW,
		});

		expect(result.state).toBe("blocked");
	});

	it("does not revive a block when every colliding event is inactive", () => {
		const pass: ListingLabelEvent = {
			ver: 1,
			src: FIXTURE_LABELER_DID,
			uri: FIXTURE_PROFILE_URI,
			cid: FIXTURE_PROFILE_CID,
			val: LISTING_LABELS.passed,
			cts: "2026-08-24T00:00:00.000Z",
		};
		const negatedBlock: ListingLabelEvent = {
			...pass,
			val: LISTING_LABELS.blocked,
			neg: true,
			cts: "2026-08-24T00:00:01.000Z",
		};
		const result = evaluateHydratedListingVisibility({
			subject: {
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_PROFILE_CID,
				kind: "profile",
				publisherDid: FIXTURE_PUBLISHER_DID,
			},
			policy: INITIAL_LISTING_POLICY_FIXTURE,
			labels: [pass, negatedBlock, { ...negatedBlock, exp: "2026-08-25T00:00:00.000Z" }],
			evaluatedAt: NOW,
		});

		expect(result.state).toBe("passed");
	});

	it("rejects a cast-forged verified label on the authoritative path", () => {
		const fabricated = {
			ver: 1,
			src: FIXTURE_LABELER_DID,
			uri: FIXTURE_PROFILE_URI,
			cid: FIXTURE_PROFILE_CID,
			val: LISTING_LABELS.passed,
			cts: "2026-08-24T00:00:00.000Z",
		} as unknown as Parameters<typeof evaluateListingVisibility>[0]["labels"][number];

		expect(() =>
			evaluateListingVisibility({
				subject: {
					uri: FIXTURE_PROFILE_URI,
					cid: FIXTURE_PROFILE_CID,
					kind: "profile",
					publisherDid: FIXTURE_PUBLISHER_DID,
				},
				policy: INITIAL_LISTING_POLICY_FIXTURE,
				labels: [fabricated],
				evaluatedAt: NOW,
			}),
		).toThrow("must be verified");
	});

	it("fails closed when pass and pending are both active for the exact CID", () => {
		const pass: ListingLabelEvent = {
			ver: 1,
			src: FIXTURE_LABELER_DID,
			uri: FIXTURE_PROFILE_URI,
			cid: FIXTURE_PROFILE_CID,
			val: LISTING_LABELS.passed,
			cts: "2026-08-24T00:00:00.000Z",
		};
		const result = evaluateHydratedListingVisibility({
			subject: {
				uri: FIXTURE_PROFILE_URI,
				cid: FIXTURE_PROFILE_CID,
				kind: "profile",
				publisherDid: FIXTURE_PUBLISHER_DID,
			},
			policy: INITIAL_LISTING_POLICY_FIXTURE,
			labels: [
				pass,
				{
					...pass,
					val: LISTING_LABELS.pending,
					cts: "2026-08-24T00:00:01.000Z",
				},
			],
			evaluatedAt: NOW,
		});

		expect(result).toMatchObject({ visible: false, state: "conflict" });
	});

	it("rejects malformed subject identifiers before evaluating labels", () => {
		expect(() =>
			evaluateHydratedListingVisibility({
				subject: {
					uri: `https://${FIXTURE_PUBLISHER_DID}/${FIXTURE_PROFILE_URI}`,
					cid: FIXTURE_PROFILE_CID,
					kind: "profile",
					publisherDid: FIXTURE_PUBLISHER_DID,
				},
				policy: INITIAL_LISTING_POLICY_FIXTURE,
				labels: [],
				evaluatedAt: NOW,
			}),
		).toThrow("at:// record URI");
	});
});
