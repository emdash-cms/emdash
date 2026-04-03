/**
 * Tests for the cache warmup module.
 */

import { describe, it, expect, afterEach } from "vitest";

import { putCached } from "../../../src/lib/cache/cache-store.js";
import { warmupCache } from "../../../src/lib/cache/cache-warmup.js";
import { deleteDatabase } from "../../../src/lib/cache/db.js";

describe("warmupCache", () => {
	afterEach(async () => {
		await deleteDatabase();
	});

	it("returns empty singletons map when no cached data exists", async () => {
		const result = await warmupCache();
		expect(result.singletons.size).toBe(0);
	});

	it("loads cached manifest from IndexedDB", async () => {
		const manifest = { collections: ["posts", "pages"], version: "1.0" };
		await putCached("singletons", "manifest", manifest);

		const result = await warmupCache();
		expect(result.singletons.get("manifest")).toEqual(manifest);
	});

	it("loads cached currentUser from IndexedDB", async () => {
		const user = { id: "u1", email: "test@example.com", role: "admin" };
		await putCached("singletons", "currentUser", user);

		const result = await warmupCache();
		expect(result.singletons.get("currentUser")).toEqual(user);
	});

	it("loads both manifest and currentUser when available", async () => {
		const manifest = { version: "1.0" };
		const user = { id: "u1", email: "test@example.com" };
		await putCached("singletons", "manifest", manifest);
		await putCached("singletons", "currentUser", user);

		const result = await warmupCache();
		expect(result.singletons.size).toBe(2);
		expect(result.singletons.get("manifest")).toEqual(manifest);
		expect(result.singletons.get("currentUser")).toEqual(user);
	});

	it("ignores non-warmup singletons", async () => {
		await putCached("singletons", "settings", { title: "My Site" });

		const result = await warmupCache();
		expect(result.singletons.has("settings")).toBe(false);
	});
});
