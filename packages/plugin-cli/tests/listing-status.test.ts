import { describe, expect, it, vi } from "vitest";

import { getLatestListingAssessment, listingStatusMessage } from "../src/listing-status.js";

const URI = "at://did:plc:publisher/com.emdashcms.experimental.package.profile/audit-log";
const CID = "bafyreie6plkev3ymvqmbskhgk6kfuwxpe6izk3bbj6jc7uecwt2eqxrwra";

function assessment(state: "blocked" | "error" | "passed" | "pending" | "review" | "superseded") {
	return {
		id: "assessment-v1-example",
		src: "did:web:labels.emdashcms.com",
		subject: { kind: "profile", uri: URI, cid: CID },
		state,
		coverage: { text: "complete", links: "not-present", media: "not-present" },
		reasonCodes: state === "review" ? ["policy-finding"] : [],
		findings: [],
		summary: "The listing needs review.",
		assessmentSchemaVersion: 1,
		policyVersion: "listing-metadata-v2",
		parserVersion: "canonical-listing-input-v1",
		models: [],
		labels: [],
		createdAt: "2026-09-15T16:25:07.061Z",
	};
}

describe("listing assessment status", () => {
	it("reads the latest assessment for an exact package URI", async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : input);
			expect(url.searchParams.get("uri")).toBe(URI);
			expect(url.searchParams.get("kind")).toBe("profile");
			if (url.pathname.endsWith("listAssessments")) {
				return Response.json({ assessments: [assessment("review")] });
			}
			expect(url.pathname).toContain("getCurrentAssessment");
			expect(url.searchParams.get("cid")).toBe(CID);
			return Response.json({
				src: "did:web:labels.emdashcms.com",
				subject: { kind: "profile", uri: URI, cid: CID },
				assessment: assessment("review"),
				activeLabels: [
					{
						ver: 1,
						src: "did:web:labels.emdashcms.com",
						uri: URI,
						cid: CID,
						val: "listing-passed",
						cts: "2026-09-15T16:25:30.275Z",
						sig: { $bytes: "AA==" },
					},
				],
			});
		});

		await expect(
			getLatestListingAssessment({
				fetch,
				kind: "profile",
				labelerUrl: "https://labels.emdashcms.com",
				uri: URI,
			}),
		).resolves.toMatchObject({ state: "passed", reasonCodes: ["policy-finding"] });
	});

	it("reports no assessment as waiting for listing checks", async () => {
		const fetch = vi.fn(async () => Response.json({ assessments: [] }));

		await expect(
			getLatestListingAssessment({
				fetch,
				kind: "profile",
				labelerUrl: "https://labels.emdashcms.com",
				uri: URI,
			}),
		).resolves.toBeNull();
		expect(listingStatusMessage("Package details", null)).toBe(
			"Package details: waiting for checks",
		);
	});

	it("uses plain status messages without publisher metadata", () => {
		expect(listingStatusMessage("Package details", assessment("passed"))).toBe(
			"Package details: approved",
		);
		expect(listingStatusMessage("Package details", assessment("review"))).toBe(
			"Package details: needs review",
		);
		expect(listingStatusMessage("Package details", assessment("error"))).toBe(
			"Package details: checks could not complete",
		);
		expect(listingStatusMessage("Package details", assessment("blocked"))).toBe(
			"Package details: not approved",
		);
	});
});
