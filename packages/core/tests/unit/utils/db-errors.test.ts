import { describe, expect, it } from "vitest";

import {
	isMissingColumnError,
	getMissingColumnIdentifier,
	isMissingTableError,
} from "../../../src/utils/db-errors.js";

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

describe("isMissingColumnError", () => {
	it("detects SQLite / D1 phrasing", () => {
		expect(isMissingColumnError(new Error('no such column: "deleted_at"'))).toBe(true);
		expect(isMissingColumnError(new Error("SQLITE_ERROR: no such column: deleted_at"))).toBe(true);
	});

	it("detects PostgreSQL phrasing", () => {
		expect(isMissingColumnError(new Error('column "deleted_at" does not exist'))).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isMissingColumnError(new Error('COLUMN "deleted_at" DOES NOT EXIST'))).toBe(true);
	});

	it("rejects unrelated errors", () => {
		expect(isMissingColumnError(new Error("no such table: ec_posts"))).toBe(false);
		expect(isMissingColumnError(new Error("permission denied"))).toBe(false);
		expect(isMissingColumnError(new Error("does not exist"))).toBe(false);
		expect(isMissingColumnError(new Error('relation "ec_columns" does not exist'))).toBe(false);
	});

	it("handles non-Error inputs safely", () => {
		expect(isMissingColumnError("no such column: x")).toBe(true);
		expect(isMissingColumnError(null)).toBe(false);
		expect(isMissingColumnError(undefined)).toBe(false);
		expect(isMissingColumnError(42)).toBe(false);
	});

	it("scopes to a named column when given", () => {
		expect(isMissingColumnError(new Error('no such column: "deleted_at"'), "deleted_at")).toBe(
			true,
		);
		expect(isMissingColumnError(new Error("no such column: name"), "deleted_at")).toBe(false);
	});
});

describe("getMissingColumnIdentifier", () => {
	it.each([
		["no such column: _emdash_missing", "_emdash_missing"],
		['no such column: "missing" - should this be a string literal in single-quotes?', "missing"],
		['column "_emdash_missing" does not exist', "_emdash_missing"],
		["no such column: b.avatar_media_id", "b.avatar_media_id"],
		["column b.avatar_media_id does not exist", "b.avatar_media_id"],
		['column "ec_posts"."missing" does not exist', "ec_posts.missing"],
		["D1_ERROR: no such column: r.slug: SQLITE_ERROR", "r.slug"],
		["COLUMN _emdash_relations.slug DOES NOT EXIST", "_emdash_relations.slug"],
		["query on _emdash_relations.slug failed: no such column: title", "title"],
		['column "title" does not exist; query referenced _emdash_bylines.avatar_media_id', "title"],
	])("extracts only the missing identifier from %s", (message, identifier) => {
		expect(getMissingColumnIdentifier(new Error(message))).toBe(identifier);
	});

	it.each([
		"no such column: title; query referenced _emdash_relations.slug",
		"no such table: _emdash_relations",
		"column permission denied",
		null,
		undefined,
		42,
	])("rejects unrelated or ambiguous errors: %s", (error) => {
		expect(getMissingColumnIdentifier(error)).toBeUndefined();
	});
});
