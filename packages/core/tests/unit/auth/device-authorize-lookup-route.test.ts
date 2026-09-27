import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/oauth/device/authorize.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const editor = { id: "user-1", email: "editor@example.com", role: Role.EDITOR };

describe("GET /_emdash/api/oauth/device/authorize", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function insertDeviceCode(values: {
		user_code: string;
		scopes: string[];
		status?: string;
		expires_at?: string;
	}) {
		await db
			.insertInto("_emdash_device_codes")
			.values({
				device_code: `dc-${values.user_code}`,
				user_code: values.user_code,
				scopes: JSON.stringify(values.scopes),
				status: values.status ?? "pending",
				expires_at: values.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
				interval: 5,
			})
			.execute();
	}

	function callGet(query: string, user: unknown = editor) {
		const url = new URL(`http://localhost/_emdash/api/oauth/device/authorize${query}`);
		return GET({
			url,
			request: new Request(url),
			locals: { emdash: { db }, user },
		} as unknown as Parameters<typeof GET>[0]);
	}

	it("requires an authenticated user", async () => {
		await insertDeviceCode({ user_code: "ABCD-EFGH", scopes: ["content:read"] });

		const res = await callGet("?user_code=ABCD-EFGH", null);

		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.data).toBeUndefined();
	});

	it("rejects a missing user_code", async () => {
		const res = await callGet("");
		expect(res.status).toBe(400);
	});

	it("returns INVALID_CODE for an unknown code", async () => {
		await insertDeviceCode({ user_code: "ABCD-EFGH", scopes: ["content:read"] });

		const res = await callGet("?user_code=ZZZZ-ZZZZ");

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe("INVALID_CODE");
	});

	it("returns EXPIRED_CODE for an expired code", async () => {
		await insertDeviceCode({
			user_code: "ABCD-EFGH",
			scopes: ["admin"],
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});

		const res = await callGet("?user_code=ABCD-EFGH");

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe("EXPIRED_CODE");
		expect(body.data).toBeUndefined();

		const row = await db
			.selectFrom("_emdash_device_codes")
			.select("device_code")
			.where("device_code", "=", "dc-ABCD-EFGH")
			.executeTakeFirst();
		expect(row).toBeDefined();
	});

	it("does not reveal scopes of a code that is no longer pending", async () => {
		await insertDeviceCode({ user_code: "ABCD-EFGH", scopes: ["admin"], status: "authorized" });

		const res = await callGet("?user_code=ABCD-EFGH");

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error.code).toBe("INVALID_CODE");
	});

	it("returns only the requested scopes and those the viewer's role would grant", async () => {
		await insertDeviceCode({
			user_code: "ABCD-EFGH",
			scopes: ["content:read", "schema:write", "admin"],
		});

		const res = await callGet("?user_code=abcdefgh");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data).toEqual({
			requestedScopes: ["content:read", "schema:write", "admin"],
			grantedScopes: ["content:read"],
		});
	});

	it("matches the scopes a subsequent approval grants", async () => {
		await insertDeviceCode({
			user_code: "ABCD-EFGH",
			scopes: ["content:read", "media:write", "schema:write"],
		});

		const lookup = await (await callGet("?user_code=ABCD-EFGH")).json();

		const approve = await POST({
			request: new Request("http://localhost/_emdash/api/oauth/device/authorize", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user_code: "ABCD-EFGH", action: "approve" }),
			}),
			locals: { emdash: { db }, user: editor },
		} as unknown as Parameters<typeof POST>[0]);
		expect(approve.status).toBe(200);

		const row = await db
			.selectFrom("_emdash_device_codes")
			.select("scopes")
			.where("device_code", "=", "dc-ABCD-EFGH")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(row.scopes)).toEqual(lookup.data.grantedScopes);
	});
});
