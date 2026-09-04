import { describe, expect, it } from "vitest";

import { getContentPublishingState } from "../../src/lib/content-publishing-state.js";

describe("getContentPublishingState", () => {
	it.each([
		["draft", false, false, null],
		["scheduled", false, false, "2027-06-01T12:00:00.000Z"],
		["published", true, false, null],
		["published-with-changes", true, true, null],
		["update-scheduled", true, true, "2027-06-01T12:00:00.000Z"],
		["published-scheduled", true, false, "2027-06-01T12:00:00.000Z"],
	] as const)(
		"derives %s from live, draft, and schedule state",
		(expected, isLive, changes, at) => {
			expect(
				getContentPublishingState({
					isLive,
					hasPendingChanges: changes,
					scheduledAt: at,
				}),
			).toBe(expected);
		},
	);
});
