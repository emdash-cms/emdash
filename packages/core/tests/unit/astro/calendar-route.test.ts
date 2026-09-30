import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/calendar.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("GET /_emdash/api/calendar", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function context(role: RoleLevel | null, query: string): APIContext {
		return {
			locals: { emdash: { db }, user: role === null ? null : { id: "user-1", role } },
			url: new URL(`http://localhost/_emdash/api/calendar?${query}`),
		} as unknown as APIContext;
	}

	const march = "from=2030-03-01T00:00:00Z&to=2030-04-01T00:00:00%2B00:00";

	it("lets contributors and above read the calendar", async () => {
		expect((await GET(context(null, march))).status).toBe(401);
		expect((await GET(context(Role.SUBSCRIBER, march))).status).toBe(403);

		const response = await GET(context(Role.CONTRIBUTOR, march));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true, data: { items: [] } });
	});

	it("reads bounds with an offset as instants", async () => {
		await new ContentRepository(db).create({
			type: "post",
			slug: "launch",
			data: { title: "Launch" },
			status: "published",
			publishedAt: "2030-03-05T10:00:00.000Z",
		});

		const response = await GET(
			context(Role.CONTRIBUTOR, "from=2030-03-05T12:00:00%2B02:00&to=2030-05-06T12:00:00%2B02:00"),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: { items: [{ title: "Launch", at: "2030-03-05T10:00:00.000Z" }] },
		});
	});

	it("rejects a reversed range and a range over 62 days", async () => {
		const reversed = await GET(
			context(Role.EDITOR, "from=2030-04-01T00:00:00Z&to=2030-03-01T00:00:00Z"),
		);
		const tooLong = await GET(
			context(Role.EDITOR, "from=2030-01-01T00:00:00Z&to=2030-03-05T00:00:00Z"),
		);

		for (const response of [reversed, tooLong]) {
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		}
	});

	it("rejects a malformed cursor", async () => {
		const response = await GET(context(Role.EDITOR, `${march}&cursor=not-a-cursor`));

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_CURSOR" } });
	});
});
