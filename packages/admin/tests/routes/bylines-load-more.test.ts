import { describe, expect, it } from "vitest";

import { loadMoreSnapshotMatches, type LoadMoreSnapshot } from "../../src/routes/bylines";

describe("loadMoreSnapshotMatches", () => {
	const baseSnapshot: LoadMoreSnapshot = {
		search: "alice",
		guestFilter: "all",
		locale: "en",
		cursor: "abc",
	};

	it("returns true when all filters still match", () => {
		expect(
			loadMoreSnapshotMatches(baseSnapshot, {
				search: "alice",
				guestFilter: "all",
				locale: "en",
			}),
		).toBe(true);
	});

	it("returns false when the locale changed while the request was in flight", () => {
		// Click Load more in en → switch to de → request resolves.
		// English rows must NOT be appended to the German list.
		expect(
			loadMoreSnapshotMatches(baseSnapshot, {
				search: "alice",
				guestFilter: "all",
				locale: "de",
			}),
		).toBe(false);
	});

	it("returns false when the search filter changed", () => {
		expect(
			loadMoreSnapshotMatches(baseSnapshot, {
				search: "bob",
				guestFilter: "all",
				locale: "en",
			}),
		).toBe(false);
	});

	it("returns false when the guest filter changed", () => {
		expect(
			loadMoreSnapshotMatches(baseSnapshot, {
				search: "alice",
				guestFilter: "guest",
				locale: "en",
			}),
		).toBe(false);
	});

	it("does not consider the cursor — different cursors of the same filter set match", () => {
		// Cursor is part of the request identity, not the filter state.
		// Pagination cursors evolve as the user pages; that's expected.
		expect(
			loadMoreSnapshotMatches(
				{ ...baseSnapshot, cursor: "xyz" },
				{ search: "alice", guestFilter: "all", locale: "en" },
			),
		).toBe(true);
	});
});
