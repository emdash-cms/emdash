import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	GET,
	POST,
} from "../../../src/astro/routes/api/content/[collection]/[id]/threads/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const USER = "user-ada";

describe("editorial thread routes", () => {
	let db: Kysely<Database>;
	let entryId: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values({ id: USER, email: "ada@example.com", name: "Ada", role: 20, email_verified: 1 })
			.execute();
		entryId = (await new ContentRepository(db).create({ type: "post", data: { title: "One" } })).id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function call(
		route: typeof GET,
		role: number,
		init: { method: string; body?: unknown },
	): Promise<Response> {
		const url = `http://localhost/_emdash/api/content/post/${entryId}/threads`;
		const request = new Request(url, {
			method: init.method,
			headers: { "Content-Type": "application/json" },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the routes read only these fields
		const context = {
			params: { collection: "post", id: entryId },
			request,
			url: new URL(url),
			locals: { user: { id: USER, role }, emdash: { db } },
		} as unknown as APIContext;
		return Promise.resolve(route(context));
	}

	it("refuses subscribers, who can't read drafts", async () => {
		const response = await call(GET, Role.SUBSCRIBER, { method: "GET" });

		expect(response.status).toBe(403);
	});

	it("lets a contributor start a thread and read it back", async () => {
		const created = await call(POST, Role.CONTRIBUTOR, {
			method: "POST",
			body: { anchor: { type: "field", field: "title" }, body: "Punchier?" },
		});
		const listed = await call(GET, Role.CONTRIBUTOR, { method: "GET" });

		expect(created.status).toBe(201);
		const { data } = (await listed.json()) as {
			data: { items: { comments: { body: string }[] }[] };
		};
		expect(data.items.map((t) => t.comments[0]!.body)).toEqual(["Punchier?"]);
	});

	it("rejects a text anchor whose quote doesn't match its range", async () => {
		const response = await call(POST, Role.CONTRIBUTOR, {
			method: "POST",
			body: {
				anchor: {
					type: "text",
					field: "content",
					blockKey: "b1",
					start: 0,
					end: 3,
					quote: "quick",
					prefix: "",
					suffix: "",
				},
				body: "Hm",
			},
		});

		expect(response.status).toBe(400);
	});
});
