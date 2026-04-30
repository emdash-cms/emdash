import { unlinkSync } from "node:fs";

import type { Kysely } from "kysely";
import { describe, it, expect, afterEach } from "vitest";

import {
	createDatabase,
	EmDashDatabaseError,
	formatNativeModuleVersionError,
} from "../../src/database/connection.js";
import type { Database } from "../../src/database/types.js";

describe("createDatabase", () => {
	let db: Kysely<Database> | undefined;

	afterEach(async () => {
		if (db) {
			await db.destroy();
			db = undefined;
		}
	});

	describe("in-memory SQLite", () => {
		it("should create in-memory database with :memory: URL", () => {
			db = createDatabase({ url: ":memory:" });
			expect(db).toBeDefined();
		});

		it("should allow queries on in-memory database", async () => {
			db = createDatabase({ url: ":memory:" });

			// Create a simple table
			await db.schema
				.createTable("test")
				.addColumn("id", "text", (col) => col.primaryKey())
				.execute();

			// Insert a row
			await db
				.insertInto("test" as any)
				.values({ id: "test-1" })
				.execute();

			// Query it back
			const result = await db
				.selectFrom("test" as any)
				.selectAll()
				.execute();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("test-1");
		});
	});

	describe("file-based SQLite", () => {
		const testDbPath = "./test-db.sqlite";

		afterEach(() => {
			try {
				unlinkSync(testDbPath);
			} catch {
				// Ignore if file doesn't exist
			}
		});

		it("should create file-based database with file: URL", () => {
			db = createDatabase({ url: `file:${testDbPath}` });
			expect(db).toBeDefined();
		});

		it("should persist data to file", async () => {
			// Create database and insert data
			db = createDatabase({ url: `file:${testDbPath}` });

			await db.schema
				.createTable("test")
				.addColumn("id", "text", (col) => col.primaryKey())
				.execute();

			await db
				.insertInto("test" as any)
				.values({ id: "test-1" })
				.execute();
			await db.destroy();
			db = undefined;

			// Reopen database and verify data persists
			db = createDatabase({ url: `file:${testDbPath}` });
			const result = await db
				.selectFrom("test" as any)
				.selectAll()
				.execute();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("test-1");
		});
	});

	describe("libSQL / Turso", () => {
		it("should throw error for libsql URL without auth token", () => {
			expect(() => {
				createDatabase({ url: "libsql://example.turso.io" });
			}).toThrow(EmDashDatabaseError);

			expect(() => {
				createDatabase({ url: "libsql://example.turso.io" });
			}).toThrow("Auth token required");
		});

		it("should throw not implemented error for libsql URL with token", () => {
			expect(() => {
				createDatabase({
					url: "libsql://example.turso.io",
					authToken: "test-token",
				});
			}).toThrow("LibSQL not yet implemented");
		});
	});

	describe("error handling", () => {
		it("should throw EmDashDatabaseError for invalid URL scheme", () => {
			expect(() => {
				createDatabase({ url: "invalid://test" });
			}).toThrow(EmDashDatabaseError);

			expect(() => {
				createDatabase({ url: "invalid://test" });
			}).toThrow("Unsupported database URL scheme");
		});

		it("should throw EmDashDatabaseError for malformed file path", () => {
			expect(() => {
				createDatabase({ url: "file:/nonexistent/path/to/db.sqlite" });
			}).toThrow(EmDashDatabaseError);
		});

		it("should wrap underlying errors in EmDashDatabaseError", () => {
			try {
				createDatabase({ url: "file:/root/cannot-write-here.db" });
			} catch (error) {
				expect(error).toBeInstanceOf(EmDashDatabaseError);
				expect(error).toHaveProperty("cause");
			}
		});
	});

	describe("formatNativeModuleVersionError", () => {
		it("returns an actionable message for NODE_MODULE_VERSION mismatch", () => {
			const err = new Error(
				"The module '/path/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version of Node.js requires NODE_MODULE_VERSION 127.",
			);
			const message = formatNativeModuleVersionError(err);
			expect(message).not.toBeNull();
			expect(message).toContain("better-sqlite3");
			expect(message).toMatch(/rebuild/i);
		});

		it("returns null for unrelated errors", () => {
			expect(formatNativeModuleVersionError(new Error("disk full"))).toBeNull();
			expect(formatNativeModuleVersionError("some string")).toBeNull();
		});
	});

	describe("connection lifecycle", () => {
		it("should allow closing connection with destroy()", async () => {
			db = createDatabase({ url: ":memory:" });
			await expect(db.destroy()).resolves.not.toThrow();
			db = undefined;
		});

		it("should return functional Kysely instance", () => {
			db = createDatabase({ url: ":memory:" });

			// Check for Kysely methods
			expect(db.selectFrom).toBeInstanceOf(Function);
			expect(db.insertInto).toBeInstanceOf(Function);
			expect(db.updateTable).toBeInstanceOf(Function);
			expect(db.deleteFrom).toBeInstanceOf(Function);
			expect(db.schema).toBeDefined();
		});
	});
});
