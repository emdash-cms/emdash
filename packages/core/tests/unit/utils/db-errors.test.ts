import { describe, expect, it } from "vitest";

import { isMissingTableError } from "../../../src/utils/db-errors.js";

describe("isMissingTableError", () => {
	it("detects SQLite / D1 phrasing", () => {
		expect(isMissingTableError(new Error("SQLITE_ERROR: no such table: _emdash_bylines"))).toBe(
			true,
		);
		expect(isMissingTableError(new Error("no such table: content_taxonomies"))).toBe(true);
	});

	it("detects PostgreSQL relation phrasing", () => {
		expect(isMissingTableError(new Error('relation "_emdash_bylines" does not exist'))).toBe(true);
		expect(
			isMissingTableError(new Error('ERROR: relation "content_taxonomies" does not exist')),
		).toBe(true);
	});

	it("detects PostgreSQL table phrasing", () => {
		expect(isMissingTableError(new Error('table "ec_posts" does not exist'))).toBe(true);
	});

	it("detects MySQL-style doesn't exist phrasing", () => {
		expect(isMissingTableError(new Error("Table 'db.foo' doesn't exist"))).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isMissingTableError(new Error('RELATION "foo" DOES NOT EXIST'))).toBe(true);
	});

	it("rejects unrelated errors", () => {
		expect(isMissingTableError(new Error("column missing"))).toBe(false);
		expect(isMissingTableError(new Error("permission denied"))).toBe(false);
		expect(isMissingTableError(new Error("does not exist"))).toBe(false); // no table/relation word
		expect(isMissingTableError(new Error("syntax error"))).toBe(false);
	});

	it("handles non-Error inputs safely", () => {
		expect(isMissingTableError("no such table: x")).toBe(true);
		expect(isMissingTableError(null)).toBe(false);
		expect(isMissingTableError(undefined)).toBe(false);
		expect(isMissingTableError(42)).toBe(false);
		expect(isMissingTableError({})).toBe(false);
	});
});
