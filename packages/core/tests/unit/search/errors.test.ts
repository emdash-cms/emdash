import { describe, expect, it, vi } from "vitest";

import { handleError, mapErrorStatus } from "../../../src/api/error.js";
import { normalizeSearchError, SearchUnavailableError } from "../../../src/search/errors.js";

describe("search errors", () => {
	it.each([
		"no such module: fts5",
		"no such function: bm25",
		"D1_ERROR: no such function: bm25: SQLITE_ERROR",
	])("reports missing FTS5 (%s) without exposing the database message", async (message) => {
		const cause = new Error(message);
		const error = normalizeSearchError(cause);
		expect(error).toBeInstanceOf(SearchUnavailableError);
		expect((error as Error).cause).toBe(cause);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = handleError(error, "Search failed", "SEARCH_ERROR");
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				success: false,
				error: { code: "SEARCH_UNAVAILABLE", message: (error as Error).message },
			});
			expect((error as Error).message).not.toContain(message);
		} finally {
			log.mockRestore();
		}
		expect(mapErrorStatus("SEARCH_UNAVAILABLE")).toBe(503);
	});

	it.each([
		new Error("fts5: syntax error near something"),
		new Error("database disk image is malformed"),
		new Error("no such table: _emdash_fts_posts"),
		new Error("no such module: fts50"),
		new Error("no such function: bm25_other"),
		"no such module: fts5",
		null,
	])("preserves other errors (%s)", (error) => {
		expect(normalizeSearchError(error)).toBe(error);
	});
});
