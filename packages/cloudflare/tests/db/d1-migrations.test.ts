import { getCoreMigrationIdentity } from "emdash/migrations";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigrationExecutor } from "../../src/db/d1-migrations.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "d1-test-token";
const originalFetch = globalThis.fetch;

function response(result: unknown): Response {
	return Response.json({ success: true, errors: [], messages: [], result });
}

function queryResponse(results: Record<string, unknown>[] = []): Response {
	return response([
		{
			success: true,
			results,
			meta: {
				changed_db: false,
				changes: 0,
				duration: 0.1,
				last_row_id: null,
				rows_read: results.length,
				rows_written: 0,
				size_after: 4096,
			},
		},
	]);
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("D1 migration executor", () => {
	it("constructs from remote metadata without issuing SQL, then checks through the REST dialect", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (!url.endsWith("/query")) {
				return response({ uuid: DATABASE_ID, name: "site-db", version: "production" });
			}
			return response([
				{
					success: false,
					error: "no such table: _emdash_migrations",
					results: [],
				},
			]);
		});
		globalThis.fetch = fetch;
		const executor = await createMigrationExecutor(
			{ binding: "DB" },
			{
				projectRoot: "/project",
				env: { CLOUDFLARE_API_TOKEN: TOKEN },
				overrides: { accountId: ACCOUNT_ID, d1: DATABASE_ID },
			},
		);

		expect(fetch).toHaveBeenCalledTimes(1);
		const firstInput = fetch.mock.calls[0]?.[0];
		expect(firstInput instanceof Request ? firstInput.url : firstInput?.toString()).not.toContain(
			"/query",
		);
		const identity = await getCoreMigrationIdentity();
		await expect(
			executor.execute({
				action: "check",
				i18n: null,
				artifact: {
					emdashVersion: identity.emdashVersion,
					migrationSetFingerprint: identity.fingerprint,
				},
			}),
		).resolves.toMatchObject({ pending: identity.names, executed: [] });
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("applies a pending migration through the REST dialect", async () => {
		const identity = await getCoreMigrationIdentity();
		const pendingMigration = identity.names.at(-1);
		if (!pendingMigration) throw new Error("Expected at least one core migration.");

		const applied = new Set(identity.names.slice(0, -1));
		const tables = ["_emdash_migrations", "_emdash_migrations_lock", "_emdash_collections"];
		const requests: Array<{ sql: string; params: unknown[] }> = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (!url.endsWith("/query")) {
				return response({ uuid: DATABASE_ID, name: "site-db", version: "production" });
			}
			if (typeof init?.body !== "string") throw new Error("Expected a JSON query body.");
			const request = JSON.parse(init.body) as { sql: string; params: unknown[] };
			requests.push(request);

			if (/\bfrom\s+["`]?sqlite_master["`]?/i.test(request.sql)) {
				return queryResponse(
					tables.map((name) => ({
						name,
						type: "table",
						sql: `CREATE TABLE "${name}" (id TEXT)`,
					})),
				);
			}
			if (/\bfrom\s+["`]?_emdash_migrations["`]?\b/i.test(request.sql)) {
				if (/count\(\*\)/i.test(request.sql)) {
					return queryResponse([{ count: applied.size }]);
				}
				return queryResponse(
					Array.from(applied, (name, index) => ({
						name,
						timestamp: new Date(index).toISOString(),
					})),
				);
			}
			if (/\binsert\s+into\s+["`]?_emdash_migrations["`]?\b/i.test(request.sql)) {
				applied.add(String(request.params[0]));
			}
			return queryResponse();
		});
		globalThis.fetch = fetch;

		const executor = await createMigrationExecutor(
			{ binding: "DB" },
			{
				projectRoot: "/project",
				env: { CLOUDFLARE_API_TOKEN: TOKEN },
				overrides: { accountId: ACCOUNT_ID, d1: DATABASE_ID },
			},
		);

		await expect(
			executor.execute({
				action: "apply",
				i18n: null,
				artifact: {
					emdashVersion: identity.emdashVersion,
					migrationSetFingerprint: identity.fingerprint,
				},
			}),
		).resolves.toMatchObject({ pending: [], executed: [pendingMigration] });
		expect(
			requests.find((request) =>
				/\binsert\s+into\s+["`]?_emdash_migrations["`]?\b/i.test(request.sql),
			)?.params[0],
		).toBe(pendingMigration);
	});

	it("fails without the API token before making a metadata request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		globalThis.fetch = fetch;

		await expect(
			createMigrationExecutor(
				{ binding: "DB" },
				{
					projectRoot: "/project",
					env: {},
					overrides: { accountId: ACCOUNT_ID, d1: DATABASE_ID },
				},
			),
		).rejects.toThrow("CLOUDFLARE_API_TOKEN");
		expect(fetch).not.toHaveBeenCalled();
	});
});
