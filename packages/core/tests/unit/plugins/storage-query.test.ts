import { describe, it, expect } from "vitest";

import { IdentifierError } from "../../../src/database/validate.js";
import {
	isRangeFilter,
	isInFilter,
	isStartsWithFilter,
	getIndexedFields,
	validateWhereClause,
	validateOrderByClause,
	jsonExtract,
	buildCondition,
	buildWhereClause,
	buildOrderByClause,
	StorageQueryError,
} from "../../../src/plugins/storage-query.js";
import { createTestDatabase } from "../../utils/test-db.js";

describe("storage-query", () => {
	const db = createTestDatabase();
	describe("type guards", () => {
		describe("isRangeFilter", () => {
			it("should return true for range filters with gt", () => {
				expect(isRangeFilter({ gt: 10 })).toBe(true);
			});

			it("should return true for range filters with gte", () => {
				expect(isRangeFilter({ gte: 10 })).toBe(true);
			});

			it("should return true for range filters with lt", () => {
				expect(isRangeFilter({ lt: 10 })).toBe(true);
			});

			it("should return true for range filters with lte", () => {
				expect(isRangeFilter({ lte: 10 })).toBe(true);
			});

			it("should return true for combined range filters", () => {
				expect(isRangeFilter({ gt: 5, lt: 10 })).toBe(true);
				expect(isRangeFilter({ gte: 5, lte: 10 })).toBe(true);
			});

			it("should return false for plain values", () => {
				expect(isRangeFilter("foo")).toBe(false);
				expect(isRangeFilter(42)).toBe(false);
				expect(isRangeFilter(null)).toBe(false);
			});

			it("should return false for other filter types", () => {
				expect(isRangeFilter({ in: [1, 2, 3] })).toBe(false);
				expect(isRangeFilter({ startsWith: "foo" })).toBe(false);
			});
		});

		describe("isInFilter", () => {
			it("should return true for in filters", () => {
				expect(isInFilter({ in: [1, 2, 3] })).toBe(true);
				expect(isInFilter({ in: ["a", "b", "c"] })).toBe(true);
				expect(isInFilter({ in: [] })).toBe(true);
			});

			it("should return false for non-array in values", () => {
				expect(isInFilter({ in: "foo" } as any)).toBe(false);
			});

			it("should return false for other filter types", () => {
				expect(isInFilter({ gt: 10 })).toBe(false);
				expect(isInFilter({ startsWith: "foo" })).toBe(false);
				expect(isInFilter("foo")).toBe(false);
			});
		});

		describe("isStartsWithFilter", () => {
			it("should return true for startsWith filters", () => {
				expect(isStartsWithFilter({ startsWith: "foo" })).toBe(true);
				expect(isStartsWithFilter({ startsWith: "" })).toBe(true);
			});

			it("should return false for non-string startsWith values", () => {
				expect(isStartsWithFilter({ startsWith: 123 } as any)).toBe(false);
			});

			it("should return false for other filter types", () => {
				expect(isStartsWithFilter({ gt: 10 })).toBe(false);
				expect(isStartsWithFilter({ in: ["a", "b"] })).toBe(false);
				expect(isStartsWithFilter("foo")).toBe(false);
			});
		});
	});

	describe("getIndexedFields", () => {
		it("should extract fields from simple indexes", () => {
			const indexes = ["status", "category"];
			const fields = getIndexedFields(indexes);

			expect(fields).toEqual(new Set(["status", "category"]));
		});

		it("should extract fields from composite indexes", () => {
			const indexes = [["status", "createdAt"], "category"];
			const fields = getIndexedFields(indexes);

			expect(fields).toEqual(new Set(["status", "createdAt", "category"]));
		});

		it("should handle empty indexes", () => {
			const fields = getIndexedFields([]);
			expect(fields).toEqual(new Set());
		});

		it("should deduplicate fields", () => {
			const indexes = ["status", ["status", "createdAt"]];
			const fields = getIndexedFields(indexes);

			expect(fields).toEqual(new Set(["status", "createdAt"]));
		});
	});

	describe("validateWhereClause", () => {
		const indexedFields = new Set(["status", "category", "createdAt"]);
		const pluginId = "test-plugin";
		const collection = "items";

		it("should pass for indexed fields", () => {
			expect(() =>
				validateWhereClause(
					{ status: "active", category: "blog" },
					indexedFields,
					pluginId,
					collection,
				),
			).not.toThrow();
		});

		it("should throw for non-indexed fields", () => {
			expect(() =>
				validateWhereClause({ title: "foo" }, indexedFields, pluginId, collection),
			).toThrow(StorageQueryError);
		});

		it("should include helpful suggestion in error", () => {
			try {
				validateWhereClause({ title: "foo" }, indexedFields, pluginId, collection);
				expect.fail("Should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(StorageQueryError);
				const error = e as StorageQueryError;
				expect(error.field).toBe("title");
				expect(error.suggestion).toContain("title");
				expect(error.suggestion).toContain(pluginId);
			}
		});

		it("should pass for empty where clause", () => {
			expect(() => validateWhereClause({}, indexedFields, pluginId, collection)).not.toThrow();
		});
	});

	describe("validateOrderByClause", () => {
		const indexedFields = new Set(["status", "createdAt"]);
		const pluginId = "test-plugin";
		const collection = "items";

		it("should pass for indexed fields", () => {
			expect(() =>
				validateOrderByClause({ createdAt: "desc" }, indexedFields, pluginId, collection),
			).not.toThrow();
		});

		it("should throw for non-indexed fields", () => {
			expect(() =>
				validateOrderByClause({ title: "asc" }, indexedFields, pluginId, collection),
			).toThrow(StorageQueryError);
		});
	});

	describe("jsonExtract", () => {
		it("should generate correct SQLite JSON extraction syntax", () => {
			expect(jsonExtract(db, "status")).toBe("json_extract(data, '$.status')");
			expect(jsonExtract(db, "created_at")).toBe("json_extract(data, '$.created_at')");
		});

		it("should accept camelCase field names (used in plugin JSON data)", () => {
			expect(jsonExtract(db, "createdAt")).toBe("json_extract(data, '$.createdAt')");
			expect(jsonExtract(db, "myField")).toBe("json_extract(data, '$.myField')");
			expect(jsonExtract(db, "UPPERCASE")).toBe("json_extract(data, '$.UPPERCASE')");
		});

		it("should reject invalid field names to prevent SQL injection", () => {
			expect(() => jsonExtract(db, "'); DROP TABLE users--")).toThrow(IdentifierError);
			expect(() => jsonExtract(db, "field.with.dots")).toThrow(IdentifierError);
			expect(() => jsonExtract(db, "field-with-hyphens")).toThrow(IdentifierError);
			expect(() => jsonExtract(db, "")).toThrow(IdentifierError);
			expect(() => jsonExtract(db, "1startsWithNumber")).toThrow(IdentifierError);
		});
	});

	describe("buildCondition", () => {
		it("should handle null values", () => {
			const result = buildCondition(db, "status", null);
			expect(result.sql).toBe("json_extract(data, '$.status') IS NULL");
			expect(result.params).toEqual([]);
		});

		it("should handle string values", () => {
			const result = buildCondition(db, "status", "active");
			expect(result.sql).toBe("json_extract(data, '$.status') = ?");
			expect(result.params).toEqual(["active"]);
		});

		it("should handle number values", () => {
			const result = buildCondition(db, "count", 42);
			expect(result.sql).toBe("json_extract(data, '$.count') = ?");
			expect(result.params).toEqual([42]);
		});

		it("should handle boolean values", () => {
			const result = buildCondition(db, "active", true);
			expect(result.sql).toBe("json_extract(data, '$.active') = ?");
			expect(result.params).toEqual([true]);
		});

		it("should handle IN filters", () => {
			const result = buildCondition(db, "status", { in: ["a", "b", "c"] });
			expect(result.sql).toBe("json_extract(data, '$.status') IN (?, ?, ?)");
			expect(result.params).toEqual(["a", "b", "c"]);
		});

		it("should handle startsWith filters", () => {
			const result = buildCondition(db, "name", { startsWith: "foo" });
			expect(result.sql).toBe("json_extract(data, '$.name') LIKE ? ESCAPE '\\'");
			expect(result.params).toEqual(["foo%"]);
		});

		it("should escape LIKE metacharacters in startsWith prefixes", () => {
			expect(buildCondition(db, "name", { startsWith: "50%" }).params).toEqual(["50\\%%"]);
			expect(buildCondition(db, "name", { startsWith: "a_b" }).params).toEqual(["a\\_b%"]);
			expect(buildCondition(db, "name", { startsWith: "c:\\dir" }).params).toEqual(["c:\\\\dir%"]);
		});

		it("should handle range filters with gt", () => {
			const result = buildCondition(db, "age", { gt: 18 });
			expect(result.sql).toBe("json_extract(data, '$.age') > ?");
			expect(result.params).toEqual([18]);
		});

		it("should handle range filters with gte", () => {
			const result = buildCondition(db, "age", { gte: 18 });
			expect(result.sql).toBe("json_extract(data, '$.age') >= ?");
			expect(result.params).toEqual([18]);
		});

		it("should handle range filters with lt", () => {
			const result = buildCondition(db, "age", { lt: 65 });
			expect(result.sql).toBe("json_extract(data, '$.age') < ?");
			expect(result.params).toEqual([65]);
		});

		it("should handle range filters with lte", () => {
			const result = buildCondition(db, "age", { lte: 65 });
			expect(result.sql).toBe("json_extract(data, '$.age') <= ?");
			expect(result.params).toEqual([65]);
		});

		it("should handle combined range filters", () => {
			const result = buildCondition(db, "age", { gte: 18, lt: 65 });
			expect(result.sql).toBe(
				"json_extract(data, '$.age') >= ? AND json_extract(data, '$.age') < ?",
			);
			expect(result.params).toEqual([18, 65]);
		});
	});

	describe("buildWhereClause", () => {
		it("should return empty result for empty where", () => {
			const result = buildWhereClause(db, {});
			expect(result.sql).toBe("");
			expect(result.params).toEqual([]);
		});

		it("should handle single condition", () => {
			const result = buildWhereClause(db, { status: "active" });
			expect(result.sql).toBe("json_extract(data, '$.status') = ?");
			expect(result.params).toEqual(["active"]);
		});

		it("should combine multiple conditions with AND", () => {
			const result = buildWhereClause(db, {
				status: "active",
				category: "blog",
			});
			expect(result.sql).toBe(
				"json_extract(data, '$.status') = ? AND json_extract(data, '$.category') = ?",
			);
			expect(result.params).toEqual(["active", "blog"]);
		});

		it("should handle mixed filter types", () => {
			const result = buildWhereClause(db, {
				status: { in: ["active", "pending"] },
				name: { startsWith: "test" },
				count: { gte: 5 },
			});
			expect(result.sql).toContain("IN (?, ?)");
			expect(result.sql).toContain("LIKE ? ESCAPE");
			expect(result.sql).toContain(">= ?");
			expect(result.params).toEqual(["active", "pending", "test%", 5]);
		});
	});

	describe("buildOrderByClause", () => {
		it("should return empty string for empty orderBy", () => {
			const result = buildOrderByClause(db, {});
			expect(result).toBe("");
		});

		it("should handle single field ascending", () => {
			const result = buildOrderByClause(db, { createdAt: "asc" });
			expect(result).toBe("ORDER BY json_extract(data, '$.createdAt') ASC");
		});

		it("should handle single field descending", () => {
			const result = buildOrderByClause(db, { createdAt: "desc" });
			expect(result).toBe("ORDER BY json_extract(data, '$.createdAt') DESC");
		});

		it("should handle multiple fields", () => {
			const result = buildOrderByClause(db, {
				category: "asc",
				createdAt: "desc",
			});
			expect(result).toBe(
				"ORDER BY json_extract(data, '$.category') ASC, json_extract(data, '$.createdAt') DESC",
			);
		});
	});
});
