/**
 * Object-cache purge handlers.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	FIXED_OBJECT_CACHE_NAMESPACES,
	handleObjectCachePurge,
	resolveObjectCacheNamespaces,
} from "../../../src/api/handlers/object-cache.js";
import type { Database } from "../../../src/database/types.js";
import * as objectCache from "../../../src/object-cache/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("resolveObjectCacheNamespaces", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("expands * to fixed namespaces when no collections exist", async () => {
		const result = await resolveObjectCacheNamespaces(db, { namespaces: ["*"] });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual([...FIXED_OBJECT_CACHE_NAMESPACES]);
	});

	it("accepts fixed namespace names", async () => {
		const result = await resolveObjectCacheNamespaces(db, {
			namespaces: ["menus", "settings"],
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual(["menus", "settings"]);
	});

	it("maps bare collection slugs to content: namespaces", async () => {
		const result = await resolveObjectCacheNamespaces(db, {
			namespaces: ["posts"],
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data).toEqual(["content:posts"]);
	});

	it("rejects unknown namespaces", async () => {
		const result = await resolveObjectCacheNamespaces(db, {
			namespaces: ["not-a-real-namespace!!"],
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});
});

describe("handleObjectCachePurge", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("bumps epochs for requested namespaces", async () => {
		const invalidate = vi.spyOn(objectCache, "invalidateObjectCache");
		const menus = vi.spyOn(objectCache, "invalidateMenuObjectCache");

		const result = await handleObjectCachePurge(db, {
			namespaces: ["menus", "content:posts"],
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.purged).toEqual(["menus", "content:posts"]);
		expect(menus).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledWith("content:posts");
	});

	it("returns configured:false when no backend is configured", async () => {
		const result = await handleObjectCachePurge(db, { namespaces: ["settings"] });
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.configured).toBe(false);
		expect(result.data.active).toBe(false);
		expect(result.data.purged).toContain("settings");
	});
});
