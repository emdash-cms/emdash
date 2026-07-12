import { describe, expect, it } from "vitest";

import {
	serializePublicFinding,
	toPublicFinding,
	type PrivateFindingRecord,
	type PublicFindingView,
} from "../src/evidence.js";

const PRIVATE_RECORD: PrivateFindingRecord = {
	id: "find_01example",
	assessmentId: "asmt_01example",
	category: "malware",
	severity: "critical",
	title: "known malicious hash",
	publicSummary: "the bundle matched a known malicious hash",
	privateDetail: "sha256 abc123 matches denylist entry NASTY-001",
	evidenceRefs: ["file:src/index.js"],
};

describe("evidence public/private boundary", () => {
	it("strips private fields at runtime when narrowing to the public view", () => {
		const publicView = toPublicFinding(PRIVATE_RECORD);
		expect(publicView).toEqual({
			id: PRIVATE_RECORD.id,
			assessmentId: PRIVATE_RECORD.assessmentId,
			category: PRIVATE_RECORD.category,
			severity: PRIVATE_RECORD.severity,
			title: PRIVATE_RECORD.title,
			publicSummary: PRIVATE_RECORD.publicSummary,
		});
		expect(publicView).not.toHaveProperty("privateDetail");
		expect(publicView).not.toHaveProperty("evidenceRefs");
	});

	it("serializes only the public-facing fields for the public API", () => {
		const publicView = toPublicFinding(PRIVATE_RECORD);
		const payload = serializePublicFinding(publicView);
		expect(payload).toEqual({
			id: PRIVATE_RECORD.id,
			category: PRIVATE_RECORD.category,
			severity: PRIVATE_RECORD.severity,
			title: PRIVATE_RECORD.title,
			summary: PRIVATE_RECORD.publicSummary,
		});
		expect(JSON.stringify(payload)).not.toContain("denylist");
	});

	it("type-rejects a private record passed directly to the public serializer", () => {
		// Compile-time assertion: PrivateFindingRecord's `privateDetail`/
		// `evidenceRefs` are typed `string`/`readonly string[]`, which are not
		// assignable to PublicFindingView's `never`-typed equivalents. If this
		// stops erroring, the type-level boundary has been weakened.
		// @ts-expect-error a private finding record must not satisfy the public view
		const rejected: PublicFindingView = PRIVATE_RECORD;
		expect(rejected).toBeDefined();
	});
});
