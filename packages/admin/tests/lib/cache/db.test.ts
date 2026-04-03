/**
 * Tests for the IndexedDB database setup module.
 */

import { describe, it, expect, afterEach } from "vitest";

import {
	DB_NAME,
	DB_VERSION,
	deleteDatabase,
	getDB,
	isIDBAvailable,
} from "../../../src/lib/cache/db.js";

describe("db", () => {
	afterEach(async () => {
		await deleteDatabase();
	});

	describe("isIDBAvailable", () => {
		it("returns true in browser environment", () => {
			expect(isIDBAvailable()).toBe(true);
		});
	});

	describe("getDB", () => {
		it("returns a database connection", async () => {
			const db = await getDB();
			expect(db.name).toBe(DB_NAME);
			expect(db.version).toBe(DB_VERSION);
		});

		it("returns the same connection on subsequent calls", async () => {
			const db1 = await getDB();
			const db2 = await getDB();
			expect(db1).toBe(db2);
		});

		it("creates all expected object stores", async () => {
			const db = await getDB();
			const storeNames = [...db.objectStoreNames].toSorted();
			expect(storeNames).toEqual([
				"bylines",
				"content",
				"media",
				"menus",
				"queryMeta",
				"sections",
				"singletons",
				"taxonomyTerms",
				"users",
			]);
		});
	});

	describe("deleteDatabase", () => {
		it("deletes the database and resets the connection", async () => {
			// Open a connection first
			const db1 = await getDB();
			expect(db1).toBeDefined();

			await deleteDatabase();

			// Should get a fresh connection after delete
			const db2 = await getDB();
			expect(db2).toBeDefined();
			// Different instance since we deleted and reopened
			expect(db2).not.toBe(db1);
		});
	});
});
