/**
 * Core update check tests.
 *
 * The handler serves the options-table cache and never blocks on the
 * registry; the registry fetch itself is tested through
 * `refreshCoreUpdateCache` with a stubbed fetch. VERSION is the "dev"
 * fallback in tests, so cases that expect an update pass `current`.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CORE_UPDATE_OPTION,
	handleCoreUpdateStatus,
	isNewerVersion,
	minimumReleaseAgeSeconds,
	refreshCoreUpdateCache,
} from "../../../src/api/handlers/update-check.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const HOUR = 60 * 60 * 1000;

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

	it("treats a stable release as newer than a prerelease of the same version", () => {
		expect(isNewerVersion("0.24.0", "0.24.0-beta.1")).toBe(true);
		expect(isNewerVersion("0.24.0-beta.1", "0.24.0")).toBe(false);
		expect(isNewerVersion("0.24.0-beta.2", "0.24.0-beta.1")).toBe(false);
		expect(isNewerVersion("0.25.0", "0.24.0-beta.1")).toBe(true);
	});
});

describe("minimumReleaseAgeSeconds", () => {
	it("defaults to 24 hours and accepts durations or seconds", () => {
		expect(minimumReleaseAgeSeconds(undefined)).toBe(86_400);
		expect(minimumReleaseAgeSeconds(true)).toBe(86_400);
		expect(minimumReleaseAgeSeconds(null)).toBe(86_400);
		expect(minimumReleaseAgeSeconds({})).toBe(86_400);
		expect(minimumReleaseAgeSeconds({ minimumReleaseAge: "48h" })).toBe(172_800);
		expect(minimumReleaseAgeSeconds({ minimumReleaseAge: 3600 })).toBe(3600);
	});

	it("rejects an invalid duration", () => {
		expect(() => minimumReleaseAgeSeconds({ minimumReleaseAge: "soon" })).toThrow();
		expect(() => minimumReleaseAgeSeconds({ minimumReleaseAge: -1 })).toThrow();
	});
});

describe("handleCoreUpdateStatus", () => {
	let db: Kysely<Database>;
	const now = new Date("2026-09-27T12:00:00.000Z");
	const hoursAgo = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString();

	const cache = (releases: Record<string, string>, checkedAt = hoursAgo(1)) =>
		new OptionsRepository(db).set(CORE_UPDATE_OPTION, { releases, checkedAt });

	async function status(options?: Parameters<typeof handleCoreUpdateStatus>[1]) {
		const result = await handleCoreUpdateStatus(db, { now, current: "0.22.0", ...options });
		if (!result.success) throw new Error("status read failed");
		return result.data;
	}

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("reports no update before any registry check has run", async () => {
		const data = await status({ current: "dev" });

		expect(data.latest).toBeNull();
		expect(data.updateAvailable).toBe(false);
		expect(data.checkedAt).toBeNull();
	});

	it("reports the newest release once it has been public for 24 hours", async () => {
		const checkedAt = hoursAgo(1);
		await cache({ "0.22.0": hoursAgo(500), "0.24.0": hoursAgo(30) }, checkedAt);

		expect(await status()).toEqual({
			current: "0.22.0",
			latest: "0.24.0",
			updateAvailable: true,
			checkedAt,
		});
	});

	it("reports nothing while the only newer release is younger than 24 hours", async () => {
		await cache({ "0.22.0": hoursAgo(500), "0.24.0": hoursAgo(23.9) });

		expect(await status()).toMatchObject({ latest: "0.22.0", updateAvailable: false });
	});

	it("falls back to an older newer release when the latest one is too recent", async () => {
		await cache({ "0.22.0": hoursAgo(500), "0.23.0": hoursAgo(200), "0.23.1": hoursAgo(2) });

		expect(await status()).toMatchObject({ latest: "0.23.0", updateAvailable: true });
		expect(
			await status({
				minimumReleaseAgeSeconds: minimumReleaseAgeSeconds({ minimumReleaseAge: "7d" }),
			}),
		).toMatchObject({ latest: "0.23.0", updateAvailable: true });
		expect(
			await status({
				minimumReleaseAgeSeconds: minimumReleaseAgeSeconds({ minimumReleaseAge: "14d" }),
			}),
		).toMatchObject({ latest: "0.22.0", updateAvailable: false });
		expect(await status({ minimumReleaseAgeSeconds: 0 })).toMatchObject({
			latest: "0.23.1",
			updateAvailable: true,
		});
	});

	it("never reports an update for the dev version", async () => {
		await cache({ "0.24.0": hoursAgo(500) });

		expect(await status({ current: "dev" })).toMatchObject({ updateAvailable: false });
	});

	it("ignores a malformed cache entry", async () => {
		await new OptionsRepository(db).set(CORE_UPDATE_OPTION, { bogus: true });

		expect(await status({ current: "dev" })).toMatchObject({
			latest: null,
			updateAvailable: false,
		});
	});

	it("treats an unparsable checkedAt as no cache (so a refresh can overwrite it)", async () => {
		await cache({ "0.24.0": hoursAgo(500) }, "not-a-date");

		expect(await status({ current: "dev" })).toEqual({
			current: "dev",
			latest: null,
			updateAvailable: false,
			checkedAt: null,
		});
	});

	it("reports nothing when the check is disabled, even with a cache", async () => {
		await cache({ "0.24.0": hoursAgo(500) });

		expect(await status({ enabled: false })).toMatchObject({
			latest: null,
			updateAvailable: false,
			checkedAt: null,
		});
	});

	it("waits a day before retrying after a failed registry check", async () => {
		const fetchStub = vi.fn().mockResolvedValue(new Response("nope", { status: 503 }));
		vi.stubGlobal("fetch", fetchStub);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await handleCoreUpdateStatus(db, { current: "0.22.0" });
		await waitForDeferredTasks();
		await handleCoreUpdateStatus(db, { current: "0.22.0" });
		await waitForDeferredTasks();

		expect(fetchStub).toHaveBeenCalledTimes(1);
	});
});

describe("refreshCoreUpdateCache", () => {
	let db: Kysely<Database>;

	const packument = (
		latest: unknown,
		time: Record<string, string> = {},
		deprecated: string[] = [],
	) =>
		Response.json({
			"dist-tags": { latest },
			versions: Object.fromEntries(
				Object.keys(time).map((v) => [v, deprecated.includes(v) ? { deprecated: "broken" } : {}]),
			),
			time: { created: "2026-01-01T00:00:00.000Z", modified: "2026-09-26T10:00:00.000Z", ...time },
		});
	const refresh = (response: Response) =>
		refreshCoreUpdateCache(db, vi.fn().mockResolvedValue(response) as unknown as typeof fetch);

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("caches the publish time of each stable release up to the latest one", async () => {
		await refresh(
			packument(
				"0.24.0",
				{
					"0.23.0": "2026-08-01T00:00:00.000Z",
					"0.23.1": "2026-08-02T00:00:00.000Z",
					"0.24.0-beta.1": "2026-09-01T00:00:00.000Z",
					"0.24.0": "2026-09-26T10:00:00.000Z",
					"0.25.0": "2026-09-27T10:00:00.000Z",
				},
				["0.23.1"],
			),
		);

		const cached = await new OptionsRepository(db).get<{
			releases: Record<string, string>;
			checkedAt: string;
		}>(CORE_UPDATE_OPTION);
		expect(cached?.releases).toEqual({
			"0.23.0": "2026-08-01T00:00:00.000Z",
			"0.24.0": "2026-09-26T10:00:00.000Z",
		});
		expect(cached?.checkedAt).toBeTruthy();
	});

	it("throws on a non-OK registry response and leaves the cache alone", async () => {
		await expect(refresh(new Response("nope", { status: 503 }))).rejects.toThrow("503");
		expect(await new OptionsRepository(db).get(CORE_UPDATE_OPTION)).toBeNull();
	});

	it("rejects a registry response without a valid version", async () => {
		await expect(refresh(packument("latest"))).rejects.toThrow("valid version");
		expect(await new OptionsRepository(db).get(CORE_UPDATE_OPTION)).toBeNull();
	});

	it("rejects a registry response without a publish time for the latest version", async () => {
		await expect(
			refresh(packument("0.24.0", { "0.23.0": "2026-08-01T00:00:00.000Z" })),
		).rejects.toThrow("publish time");
		expect(await new OptionsRepository(db).get(CORE_UPDATE_OPTION)).toBeNull();
	});
});
