import { describe, it, expect } from "vitest";

import { IdentifierError } from "../../../src/database/validate.js";
import {
	generateIndexName,
	generateCreateIndexSql,
	generateDropIndexSql,
	normalizeIndexes,
} from "../../../src/plugins/storage-indexes.js";
import { createTestDatabase } from "../../utils/test-db.js";

describe("storage-indexes", () => {
	const db = createTestDatabase();
	describe("generateIndexName", () => {
		it("should generate deterministic index name for single field", () => {
			const name = generateIndexName("my-plugin", "items", ["status"]);
			expect(name).toBe("idx_plugin_my-plugin_items_status");
		});

		it("should generate deterministic index name for multiple fields", () => {
			const name = generateIndexName("my-plugin", "items", ["status", "createdAt"]);
			expect(name).toBe("idx_plugin_my-plugin_items_status_createdAt");
		});

		it("should bound long names to PostgreSQL identifiers", () => {
			const longFieldNames = Array.from({ length: 20 }, (_, i) => `veryLongFieldName${i}`);
			const name = generateIndexName("my-plugin", "items", longFieldNames);
			expect(name.length).toBeLessThanOrEqual(63);
		});

		it("should be consistent across calls", () => {
			const name1 = generateIndexName("plugin", "coll", ["a", "b"]);
			const name2 = generateIndexName("plugin", "coll", ["a", "b"]);
			expect(name1).toBe(name2);
		});
	});

	describe("generateCreateIndexSql", () => {
		it("should return a RawBuilder with CREATE INDEX", () => {
			const result = generateCreateIndexSql(db, "my-plugin", "items", ["status"]);
			// It should be a RawBuilder (has toOperationNode method)
			expect(result).toBeDefined();
			expect(typeof (result as any).toOperationNode).toBe("function");
		});

		it("should reject invalid field names", () => {
			expect(() =>
				generateCreateIndexSql(db, "my-plugin", "items", ["status; DROP TABLE users--"]),
			).toThrow(IdentifierError);
		});

		it("should reject invalid collection names", () => {
			expect(() =>
				generateCreateIndexSql(db, "my-plugin", "items'; DROP TABLE--", ["status"]),
			).toThrow(IdentifierError);
		});

		it("should reject invalid plugin IDs", () => {
			expect(() => generateCreateIndexSql(db, "'; DROP TABLE--", "items", ["status"])).toThrow(
				IdentifierError,
			);
		});

		it("should accept valid identifiers with hyphens in plugin ID", () => {
			// Should not throw
			const result = generateCreateIndexSql(db, "my-plugin", "items", ["status"]);
			expect(result).toBeDefined();
		});

		it("should accept composite field indexes", () => {
			// Should not throw
			const result = generateCreateIndexSql(db, "my-plugin", "items", ["status", "created_at"]);
			expect(result).toBeDefined();
		});
	});

	describe("generateDropIndexSql", () => {
		it("should return a RawBuilder", () => {
			const result = generateDropIndexSql("idx_plugin_my-plugin_items_status");
			expect(result).toBeDefined();
			expect(typeof (result as any).toOperationNode).toBe("function");
		});
	});

	describe("normalizeIndexes", () => {
		it("should convert single fields to arrays", () => {
			const normalized = normalizeIndexes(["status", "category"]);
			expect(normalized).toEqual([["status"], ["category"]]);
		});

		it("should keep arrays as-is", () => {
			const normalized = normalizeIndexes([["status", "createdAt"]]);
			expect(normalized).toEqual([["status", "createdAt"]]);
		});

		it("should handle mixed input", () => {
			const normalized = normalizeIndexes(["status", ["category", "priority"], "name"]);
			expect(normalized).toEqual([["status"], ["category", "priority"], ["name"]]);
		});

		it("should return empty array for empty input", () => {
			const normalized = normalizeIndexes([]);
			expect(normalized).toEqual([]);
		});
	});
});
