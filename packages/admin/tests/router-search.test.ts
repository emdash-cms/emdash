import { describe, expect, it } from "vitest";

import { parseBylinesLocaleSearch, parseContentListSearch } from "../src/router";

describe("parseBylinesLocaleSearch", () => {
	it("returns the locale string when present and non-empty", () => {
		expect(parseBylinesLocaleSearch({ locale: "de-de" })).toEqual({ locale: "de-de" });
	});

	it("normalizes empty-string locale to undefined", () => {
		// `/bylines?locale=` would otherwise leave `locale: ""` in route state.
		// The bylines API client treats empty string as truthy-omit, so the
		// page would fetch every locale's rows while UI says one is active.
		expect(parseBylinesLocaleSearch({ locale: "" })).toEqual({ locale: undefined });
	});

	it("returns undefined when locale is missing entirely", () => {
		expect(parseBylinesLocaleSearch({})).toEqual({ locale: undefined });
	});

	it("returns undefined when locale is not a string", () => {
		expect(parseBylinesLocaleSearch({ locale: 42 })).toEqual({ locale: undefined });
		expect(parseBylinesLocaleSearch({ locale: null })).toEqual({ locale: undefined });
	});
});

describe("parseContentListSearch", () => {
	it("reads a full view back off the URL", () => {
		expect(
			parseContentListSearch({
				locale: "de",
				page: "3",
				q: "draft post",
				status: "scheduled",
				author: "user_01",
				sort: "title",
				dir: "asc",
				dateField: "publishedAt",
				dateFrom: "2025-01-01",
				dateTo: "2025-03-31",
			}),
		).toEqual({
			locale: "de",
			page: 3,
			q: "draft post",
			status: "scheduled",
			author: "user_01",
			sort: "title",
			dir: "asc",
			dateField: "publishedAt",
			dateFrom: "2025-01-01",
			dateTo: "2025-03-31",
		});
	});

	it("leaves every field unset for a bare list URL", () => {
		expect(parseContentListSearch({})).toEqual({
			locale: undefined,
			page: undefined,
			q: undefined,
			status: undefined,
			author: undefined,
			sort: undefined,
			dir: undefined,
			dateField: undefined,
			dateFrom: undefined,
			dateTo: undefined,
		});
	});

	it("normalizes page 1 and below away, since page 1 is the default view", () => {
		expect(parseContentListSearch({ page: "1" }).page).toBeUndefined();
		expect(parseContentListSearch({ page: "0" }).page).toBeUndefined();
		expect(parseContentListSearch({ page: "-4" }).page).toBeUndefined();
	});

	it("rejects a non-integer page rather than passing NaN to the pager", () => {
		expect(parseContentListSearch({ page: "abc" }).page).toBeUndefined();
		expect(parseContentListSearch({ page: "2.5" }).page).toBeUndefined();
		expect(parseContentListSearch({ page: null }).page).toBeUndefined();
	});

	it("drops values outside each control's vocabulary", () => {
		const parsed = parseContentListSearch({
			status: "all",
			sort: "authorId",
			dateField: "deletedAt",
		});
		// "all" is the status filter's cleared state, not a server-side filter.
		expect(parsed.status).toBeUndefined();
		expect(parsed.sort).toBeUndefined();
		expect(parsed.dateField).toBeUndefined();
	});

	it("ignores a direction with no column to apply it to", () => {
		expect(parseContentListSearch({ dir: "asc" })).toMatchObject({
			sort: undefined,
			dir: undefined,
		});
	});

	it("defaults a column with no direction to descending", () => {
		expect(parseContentListSearch({ sort: "status" })).toMatchObject({
			sort: "status",
			dir: "desc",
		});
	});

	it("rejects date bounds the date inputs could not have produced", () => {
		// These reach the API as a range filter, so a free-form string would be
		// forwarded verbatim to the server.
		expect(parseContentListSearch({ dateFrom: "yesterday" }).dateFrom).toBeUndefined();
		expect(parseContentListSearch({ dateFrom: "2025-1-1" }).dateFrom).toBeUndefined();
		expect(parseContentListSearch({ dateTo: "2025-03-31T00:00:00Z" }).dateTo).toBeUndefined();
	});

	it("rejects dates that fit the format but never happened", () => {
		// The API rejects these, and `2025-02-31` would otherwise reach it
		// widened to a `2025-03-03` boundary.
		expect(parseContentListSearch({ dateFrom: "2025-99-99" }).dateFrom).toBeUndefined();
		expect(parseContentListSearch({ dateFrom: "2025-13-01" }).dateFrom).toBeUndefined();
		expect(parseContentListSearch({ dateTo: "2025-02-31" }).dateTo).toBeUndefined();
		expect(parseContentListSearch({ dateTo: "2025-02-29" }).dateTo).toBeUndefined();
	});

	it("keeps a leap day the calendar actually has", () => {
		expect(parseContentListSearch({ dateFrom: "2024-02-29" }).dateFrom).toBe("2024-02-29");
	});

	it("treats empty strings as absent so a blank param never filters the list", () => {
		// `?locale=` left as "" would beat the defaultLocale fallback and fetch
		// every locale's rows while the switcher claims one is active.
		const parsed = parseContentListSearch({ locale: "", q: "", author: "" });
		expect(parsed).toMatchObject({ locale: undefined, q: undefined, author: undefined });
	});
});
