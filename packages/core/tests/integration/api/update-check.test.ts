/**
 * Core update check tests (Discussion #1889).
 *
 * The handler serves the options-table cache and never blocks on the
 * registry; the registry fetch itself is tested through
 * `refreshCoreUpdateCache` with a stubbed fetch. In tests VERSION is the
 * "dev" fallback, which by design never compares as outdated.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CORE_UPDATE_OPTION,
	handleCoreUpdateStatus,
	isNewerVersion,
	refreshCoreUpdateCache,
} from "../../../src/api/handlers/update-check.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("isNewerVersion", () => {
	it("compares major.minor.patch numerically", () => {
		expect(isNewerVersion("0.24.0", "0.22.5")).toBe(true);
		expect(isNewerVersion("0.22.5", "0.24.0")).toBe(false);
		expect(isNewerVersion("0.22.10", "0.22.9")).toBe(true);
		expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
		expect(isNewerVersion("0.24.0", "0.24.0")).toBe(false);
	});

	it("treats unparsable versions as not newer", () => {
		expect(isNewerVersion("0.24.0", "dev")).toBe(false);
		expect(isNewerVersion("not-a-version", "0.1.0")).toBe(false);
		expect(isNewerVersion("", "0.1.0")).toBe(false);
	});
});

describe("handleCoreUpdateStatus", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("reports no update before any registry check has run", async () => {
		const result = await handleCoreUpdateStatus(db);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.latest).toBeNull();
		expect(result.data.updateAvailable).toBe(false);
		expect(result.data.checkedAt).toBeNull();
	});

	it("serves the cached registry result", async () => {
		const checkedAt = new Date().toISOString();
		await new OptionsRepository(db).set(CORE_UPDATE_OPTION, { latest: "0.24.0", checkedAt });

		const result = await handleCoreUpdateStatus(db);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.latest).toBe("0.24.0");
		expect(result.data.checkedAt).toBe(checkedAt);
		// VERSION is "dev" in tests, which never compares as outdated.
		expect(result.data.updateAvailable).toBe(false);
	});

	it("ignores a malformed cache entry", async () => {
		await new OptionsRepository(db).set(CORE_UPDATE_OPTION, { bogus: true });

		const result = await handleCoreUpdateStatus(db);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.latest).toBeNull();
		expect(result.data.updateAvailable).toBe(false);
	});

	it("treats an unparsable checkedAt as no cache (so a refresh can overwrite it)", async () => {
		// With a garbage date the staleness math would be NaN >= interval
		// (false) — the cache would never refresh. It must parse as absent.
		await new OptionsRepository(db).set(CORE_UPDATE_OPTION, {
			latest: "0.24.0",
			checkedAt: "not-a-date",
		});

		const result = await handleCoreUpdateStatus(db);

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.latest).toBeNull();
		expect(result.data.checkedAt).toBeNull();
		expect(result.data.updateAvailable).toBe(false);
	});

	it("reports nothing when the check is disabled, even with a cache", async () => {
		await new OptionsRepository(db).set(CORE_UPDATE_OPTION, {
			latest: "0.24.0",
			checkedAt: new Date().toISOString(),
		});

		const result = await handleCoreUpdateStatus(db, { enabled: false });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.latest).toBeNull();
		expect(result.data.updateAvailable).toBe(false);
		expect(result.data.checkedAt).toBeNull();
	});
});

describe("refreshCoreUpdateCache", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("stores the registry's latest version in the options table", async () => {
		const fetchStub = vi.fn().mockResolvedValue(Response.json({ version: "0.24.0" }));

		await refreshCoreUpdateCache(db, fetchStub as unknown as typeof fetch);

		expect(fetchStub).toHaveBeenCalledWith(
			"https://registry.npmjs.org/emdash/latest",
			expect.objectContaining({ headers: { accept: "application/json" } }),
		);
		const cached = await new OptionsRepository(db).get<{ latest: string; checkedAt: string }>(
			CORE_UPDATE_OPTION,
		);
		expect(cached?.latest).toBe("0.24.0");
		expect(cached?.checkedAt).toBeTruthy();

		const status = await handleCoreUpdateStatus(db);
		expect(status.success).toBe(true);
		if (!status.success) return;
		expect(status.data.latest).toBe("0.24.0");
	});

	it("throws on a non-OK registry response and leaves the cache alone", async () => {
		const fetchStub = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));

		await expect(refreshCoreUpdateCache(db, fetchStub as unknown as typeof fetch)).rejects.toThrow(
			"503",
		);
		expect(await new OptionsRepository(db).get(CORE_UPDATE_OPTION)).toBeNull();
	});

	it("rejects a registry response without a valid version", async () => {
		const fetchStub = vi.fn().mockResolvedValue(Response.json({ version: "latest" }));

		await expect(refreshCoreUpdateCache(db, fetchStub as unknown as typeof fetch)).rejects.toThrow(
			"valid version",
		);
		expect(await new OptionsRepository(db).get(CORE_UPDATE_OPTION)).toBeNull();
	});
});
