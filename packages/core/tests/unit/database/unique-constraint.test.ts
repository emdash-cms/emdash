import { describe, expect, it } from "vitest";

import { isUniqueConstraintViolation } from "../../../src/database/unique-constraint.js";

describe("isUniqueConstraintViolation", () => {
	it("returns true for SQLite-style messages", () => {
		expect(
			isUniqueConstraintViolation(new Error("UNIQUE constraint failed: _plugin_storage.id")),
		).toBe(true);
		expect(isUniqueConstraintViolation(new Error("unique constraint failed"))).toBe(true);
	});

	it("returns true for PostgreSQL code 23505", () => {
		expect(isUniqueConstraintViolation({ code: "23505", message: "duplicate key" })).toBe(true);
	});

	it("returns true for nested cause with PG code", () => {
		const inner = { code: "23505" };
		expect(isUniqueConstraintViolation({ cause: inner })).toBe(true);
	});

	it("returns true for Error with cause chain carrying message", () => {
		const inner = new Error('duplicate key value violates unique constraint "pk"');
		const outer = new Error("wrap");
		(outer as Error & { cause?: unknown }).cause = inner;
		expect(isUniqueConstraintViolation(outer)).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isUniqueConstraintViolation(new Error("connection refused"))).toBe(false);
		expect(isUniqueConstraintViolation(null)).toBe(false);
		expect(isUniqueConstraintViolation(undefined)).toBe(false);
	});
});
