import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
	loadProjectWranglerConfig,
	resolveD1MigrationTarget,
	type WranglerMigrationConfig,
} from "../../src/db/d1-migration-target.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "control-plane-secret";

function apiResponse(result: unknown): Response {
	return Response.json({ success: true, errors: [], messages: [], result });
}

function listApiResponse(
	result: unknown[],
	page: number,
	totalPages: number,
	totalCount: number,
): Response {
	return Response.json({
		success: true,
		errors: [],
		messages: [],
		result,
		result_info: {
			page,
			per_page: 100,
			count: result.length,
			total_count: totalCount,
			total_pages: totalPages,
		},
	});
}

function database(uuid = DATABASE_ID, name = "site-db"): Record<string, unknown> {
	return { uuid, name, version: "production" };
}

describe("resolveD1MigrationTarget", () => {
	it("preflights an explicit UUID and freezes a credential-free target", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => apiResponse(database()));
		const resolved = await resolveD1MigrationTarget(
			{ binding: "DB" },
			{
				projectRoot: "/project",
				env: { CLOUDFLARE_API_TOKEN: TOKEN },
				overrides: { accountId: ACCOUNT_ID, d1: DATABASE_ID },
			},
			{ fetch },
		);

		expect(resolved.target).toEqual({
			kind: "d1",
			label: `${ACCOUNT_ID}/site-db/${DATABASE_ID}`,
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			accountId: ACCOUNT_ID,
			resourceId: DATABASE_ID,
		});
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.target)).toBe(true);
		expect(JSON.stringify(resolved.target)).not.toContain(TOKEN);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("resolves an explicit name only when exactly one exact match exists", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			return url.searchParams.get("page") === "1"
				? listApiResponse([database(undefined, "site-db-preview")], 1, 2, 2)
				: listApiResponse([database(DATABASE_ID, "site-db")], 2, 2, 2);
		});
		const resolved = await resolveD1MigrationTarget(
			{ binding: "DB" },
			{
				projectRoot: "/project",
				env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: TOKEN },
				overrides: { d1: "site-db" },
			},
			{ fetch },
		);

		expect(resolved.databaseId).toBe(DATABASE_ID);
		const firstInput = fetch.mock.calls[0]?.[0];
		expect(firstInput instanceof Request ? firstInput.url : firstInput?.toString()).toContain(
			"name=site-db",
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects duplicate exact names found on different result pages", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			const isFirstPage = url.searchParams.get("page") === "1";
			const id = isFirstPage ? DATABASE_ID : "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
			return listApiResponse([database(id, "site-db")], isFirstPage ? 1 : 2, 2, 2);
		});

		await expect(
			resolveD1MigrationTarget(
				{ binding: "DB" },
				{
					projectRoot: "/project",
					env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: TOKEN },
					overrides: { d1: "site-db" },
				},
				{ fetch },
			),
		).rejects.toThrow(/more than one/i);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects preview metadata returned for an explicit UUID", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			apiResponse({ ...database(), version: "preview" }),
		);

		await expect(
			resolveD1MigrationTarget(
				{ binding: "DB" },
				{
					projectRoot: "/project",
					env: { CLOUDFLARE_API_TOKEN: TOKEN },
					overrides: { accountId: ACCOUNT_ID, d1: DATABASE_ID },
				},
				{ fetch },
			),
		).rejects.toThrow(/preview/i);
	});

	it("uses the selected Wrangler environment and its own binding array", async () => {
		const config: WranglerMigrationConfig = {
			accountId: ACCOUNT_ID,
			d1Databases: [{ binding: "DB", databaseName: "production-db", databaseId: DATABASE_ID }],
		};
		const readWranglerConfig = vi.fn(async () => config);
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			apiResponse(database(DATABASE_ID, "production-db")),
		);
		const resolved = await resolveD1MigrationTarget(
			{ binding: "DB" },
			{
				projectRoot: "/project",
				env: { CLOUDFLARE_API_TOKEN: TOKEN },
				overrides: { wranglerConfig: "wrangler.jsonc", wranglerEnv: "production" },
			},
			{ fetch, readWranglerConfig },
		);

		expect(readWranglerConfig).toHaveBeenCalledWith(
			"/project/wrangler.jsonc",
			"production",
			"/project",
		);
		expect(resolved.target.environment).toBe("production");
	});

	it.each([
		[
			"preview ID",
			[
				{
					binding: "DB",
					databaseName: "site-db",
					databaseId: DATABASE_ID,
					previewDatabaseId: DATABASE_ID,
				},
			],
		],
		[
			"duplicate binding",
			[
				{ binding: "DB", databaseName: "one", databaseId: DATABASE_ID },
				{ binding: "DB", databaseName: "two", databaseId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
			],
		],
		["placeholder ID", [{ binding: "DB", databaseName: "site-db", databaseId: "<DATABASE_ID>" }]],
	])("rejects a configured %s before metadata lookup", async (_name, d1Databases) => {
		const fetch = vi.fn<typeof globalThis.fetch>();

		await expect(
			resolveD1MigrationTarget(
				{ binding: "DB" },
				{
					projectRoot: "/project",
					env: { CLOUDFLARE_API_TOKEN: TOKEN },
					overrides: { wranglerConfig: "wrangler.jsonc" },
				},
				{
					fetch,
					readWranglerConfig: async () => ({ accountId: ACCOUNT_ID, d1Databases }),
				},
			),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects conflicting explicit and configured account IDs", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		await expect(
			resolveD1MigrationTarget(
				{ binding: "DB" },
				{
					projectRoot: "/project",
					env: { CLOUDFLARE_API_TOKEN: TOKEN },
					overrides: {
						accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						d1: DATABASE_ID,
						wranglerConfig: "wrangler.jsonc",
					},
				},
				{
					fetch,
					readWranglerConfig: async () => ({ accountId: ACCOUNT_ID, d1Databases: [] }),
				},
			),
		).rejects.toThrow(/account.*conflict/i);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("loadProjectWranglerConfig", () => {
	it("uses project-local Wrangler and preserves account inheritance for a named environment", async () => {
		const cloudflarePackage = resolve(import.meta.dirname, "../..");
		const projectRoot = resolve(cloudflarePackage, "../marketplace");
		const configPath = resolve(import.meta.dirname, "../fixtures/d1-wrangler.jsonc");

		await expect(loadProjectWranglerConfig(configPath, "production", projectRoot)).resolves.toEqual(
			{
				accountId: ACCOUNT_ID,
				d1Databases: [
					{
						binding: "DB",
						databaseName: "production-db",
						databaseId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
						previewDatabaseId: undefined,
					},
				],
			},
		);
	});

	it("omits the environment when selecting the top-level configuration", async () => {
		const cloudflarePackage = resolve(import.meta.dirname, "../..");
		const projectRoot = resolve(cloudflarePackage, "../marketplace");
		const configPath = resolve(import.meta.dirname, "../fixtures/d1-wrangler.jsonc");

		await expect(loadProjectWranglerConfig(configPath, undefined, projectRoot)).resolves.toEqual({
			accountId: ACCOUNT_ID,
			d1Databases: [
				{
					binding: "DB",
					databaseName: "top-level-db",
					databaseId: DATABASE_ID,
					previewDatabaseId: undefined,
				},
			],
		});
	});
});
