import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as postOptions } from "../../../src/astro/routes/api/auth/passkey/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildContext(db: Kysely<Database>, body: unknown): APIContext {
	const request = new Request("http://localhost/_emdash/api/auth/passkey/options", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		request,
		url: new URL(request.url),
		locals: { emdash: { db, config: {} } },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

async function optionsFor(db: Kysely<Database>, body: unknown) {
	const res = await postOptions(buildContext(db, body));
	expect(res.status).toBe(200);
	const json = (await res.json()) as { data: { options: Record<string, unknown> } };
	const { challenge: _challenge, ...rest } = json.data.options;
	return rest;
}

describe("POST /auth/passkey/options", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("users")
			.values({
				id: "user-1",
				email: "known@example.com",
				name: null,
				avatar_url: null,
				role: 50,
				email_verified: 1,
				data: null,
			})
			.execute();
		await db
			.insertInto("credentials")
			.values({
				id: "known-credential-id",
				user_id: "user-1",
				public_key: new Uint8Array([1, 2, 3]),
				algorithm: -7,
				counter: 0,
				device_type: "singleDevice",
				backed_up: 0,
				transports: null,
				name: null,
			})
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns the same options for a registered email, an unknown one, and no email", async () => {
		const known = await optionsFor(db, { email: "known@example.com" });
		const unknown = await optionsFor(db, { email: "nobody@example.com" });

		const noEmail = await optionsFor(db, {});

		expect(known).toEqual(unknown);
		expect(known).toEqual(noEmail);
		expect(known).not.toHaveProperty("allowCredentials");
	});
});
