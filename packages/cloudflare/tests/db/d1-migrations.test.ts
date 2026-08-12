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
