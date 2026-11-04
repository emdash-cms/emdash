import { getCoreMigrationIdentity, type MigrationRequest } from "emdash/migrations";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigrationExecutor } from "../../src/db/d1-migrations.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "d1-test-token";
const originalFetch = globalThis.fetch;

function response(result: unknown): Response {
	return Response.json({ success: true, errors: [], messages: [], result });
}

function queryResponse(results: Record<string, unknown>[] = [], changes = 0): Response {
	return response([
		{
			success: true,
			results,
			meta: {
				changed_db: changes > 0,
				changes,
				duration: 0.1,
				last_row_id: null,
				rows_read: results.length,
				rows_written: 0,
				size_after: 4096,
			},
		},
	]);
}

/** The last core migration is pending; `competing` adds an `auto`-mode Worker that takes a free lock. */
function fakeD1WithLastMigrationPending(
	names: readonly string[],
	initialLock: number,
	competing = false,
) {
	const pendingMigration = names.at(-1);
	if (!pendingMigration) throw new Error("Expected at least one core migration.");
	const applied = new Set(names.slice(0, -1));
	const tables = ["_emdash_migrations", "_emdash_migrations_lock", "_emdash_collections"];
	const requests: Array<{ sql: string; params: unknown[] }> = [];
	const lockDuringInsert: number[] = [];
	const state = { lock: initialLock, takenByRequest: 0 };
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		if (!url.endsWith("/query")) {
			return response({ uuid: DATABASE_ID, name: "site-db", version: "production" });
		}
		if (typeof init?.body !== "string") throw new Error("Expected a JSON query body.");
		const request = JSON.parse(init.body) as { sql: string; params: unknown[] };
		requests.push(request);
		if (competing && state.lock === 0 && applied.size < names.length) {
			state.lock = Date.now();
			state.takenByRequest += 1;
		}

		if (/\bfrom\s+["`]?sqlite_master["`]?/i.test(request.sql)) {
			return queryResponse(
				tables.map((name) => ({
					name,
					type: "table",
					sql: `CREATE TABLE "${name}" (id TEXT)`,
				})),
			);
		}
		if (/\bfrom\s+["`]?_emdash_migrations_lock["`]?/i.test(request.sql)) {
			return queryResponse([{ id: "migration_lock", is_locked: state.lock }]);
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
		if (/\bupdate\s+["`]?_emdash_migrations_lock["`]?/i.test(request.sql)) {
			const [value, , ...accepted] = request.params;
			if (!accepted.includes(state.lock)) return queryResponse();
			state.lock = Number(value);
			return queryResponse([], 1);
		}
		if (/\binsert\s+into\s+["`]?_emdash_migrations["`]?\b/i.test(request.sql)) {
			applied.add(String(request.params[0]));
			lockDuringInsert.push(state.lock);
		}
		return queryResponse();
	});
	return { fetch, pendingMigration, requests, lockDuringInsert, state };
}

function createExecutor() {
	return createMigrationExecutor(
		{ binding: "DB" },
		{
			projectRoot: "/project",
			env: { CLOUDFLARE_API_TOKEN: TOKEN },
			overrides: { accountId: ACCOUNT_ID, d1: DATABASE_ID },
		},
	);
}

function migrationRequest(
	identity: { emdashVersion: string; fingerprint: string },
	action: MigrationRequest["action"],
): MigrationRequest {
	return {
		action,
		i18n: null,
		artifact: {
			emdashVersion: identity.emdashVersion,
			migrationSetFingerprint: identity.fingerprint,
		},
	};
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("D1 migration executor", () => {
	it("constructs from remote metadata without issuing SQL, then checks through the REST dialect", async () => {
		const queries: string[] = [];
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (!url.endsWith("/query")) {
				return response({ uuid: DATABASE_ID, name: "site-db", version: "production" });
			}
			if (typeof init?.body !== "string") throw new Error("Expected a JSON query body.");
			const { sql } = JSON.parse(init.body) as { sql: string };
			queries.push(sql);
			const table = /\bfrom\s+"?(\w+)"?/i.exec(sql)?.[1];
			return Response.json(
				{
					success: false,
					errors: [{ code: 7500, message: `no such table: ${table}: SQLITE_ERROR` }],
					messages: [],
					result: null,
				},
				{ status: 400 },
			);
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
		expect(queries).toEqual([
			expect.stringMatching(/^select name from "_emdash_migrations"$/i),
			expect.stringMatching(/^select "is_locked" from "_emdash_migrations_lock" where/i),
		]);
	});

	it("applies a pending migration through the REST dialect while holding the migration lock", async () => {
		const identity = await getCoreMigrationIdentity();
		const d1 = fakeD1WithLastMigrationPending(identity.names, 0);
		globalThis.fetch = d1.fetch;

		await expect(
			(await createExecutor()).execute(migrationRequest(identity, "apply")),
		).resolves.toMatchObject({ pending: [], executed: [d1.pendingMigration] });
		expect(
			d1.requests.find((request) =>
				/\binsert\s+into\s+["`]?_emdash_migrations["`]?\b/i.test(request.sql),
			)?.params[0],
		).toBe(d1.pendingMigration);
		expect(d1.lockDuringInsert).toEqual([expect.any(Number)]);
		expect(d1.lockDuringInsert[0]).toBeGreaterThan(0);
		expect(d1.state.lock).toBe(0);
	});

	it("takes over a stuck lock through the REST dialect without a request taking it first", async () => {
		const identity = await getCoreMigrationIdentity();
		const stuckLock = Date.parse("2026-10-06T23:47:31.246Z");
		const d1 = fakeD1WithLastMigrationPending(identity.names, stuckLock, true);
		globalThis.fetch = d1.fetch;

		await expect(
			(await createExecutor()).execute({
				...migrationRequest(identity, "take-over-lock"),
				lockId: String(stuckLock),
			}),
		).resolves.toMatchObject({ pending: [], executed: [d1.pendingMigration] });
		expect(d1.state.takenByRequest).toBe(0);
		expect(d1.lockDuringInsert).toEqual([expect.any(Number)]);
		expect(d1.lockDuringInsert[0]).toBeGreaterThan(stuckLock);
		expect(d1.state.lock).toBe(0);
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
