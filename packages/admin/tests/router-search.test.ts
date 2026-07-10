import { describe, expect, it } from "vitest";

import { parseBylinesLocaleSearch } from "../src/router";

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
