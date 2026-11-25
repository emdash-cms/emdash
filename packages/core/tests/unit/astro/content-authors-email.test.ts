import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleContentAuthors, handleContentCreate } from "../../../src/api/handlers/content.js";
import { GET } from "../../../src/astro/routes/api/content/[collection]/authors.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("content authors route: who receives email addresses", () => {
	let db: Kysely<Database>;
	let ownerId: string;

	beforeAll(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const owner = await new UserRepository(db).create({
			email: "olivia.private@example.com",
			name: "Olivia",
			role: "admin",
		});
		ownerId = owner.id;
		const created = await handleContentCreate(db, "posts", {
			slug: "welcome",
			data: { title: "Welcome" },
			authorId: ownerId,
		});
		if (!created.success) throw new Error("seed failed");
	});

	afterAll(async () => {
		await teardownTestDatabase(db);
	});

	async function listAs(role: RoleLevel, tokenScopes?: string[]) {
		const response = await GET({
			params: { collection: "posts" },
			locals: {
				user: { id: "caller", role },
				tokenScopes,
				emdash: {
					handleContentAuthors: (collection: string, options?: { includeEmail?: boolean }) =>
						handleContentAuthors(db, collection, options),
				},
			},
		} as unknown as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { data?: { items: Record<string, unknown>[] } };
		return { status: response.status, items: body.data?.items ?? [] };
	}

	it.each([
		["contributor", Role.CONTRIBUTOR],
		["author", Role.AUTHOR],
		["editor", Role.EDITOR],
	])("withholds the email from a role below admin (%s)", async (_name, role) => {
		const { status, items } = await listAs(role);

		expect(status).toBe(200);
		expect(items).toEqual([{ id: ownerId, name: "Olivia", avatarUrl: null }]);
	});

	it("includes the email for an admin session", async () => {
		const { status, items } = await listAs(Role.ADMIN);

		expect(status).toBe(200);
		expect(items).toEqual([
			{ id: ownerId, name: "Olivia", email: "olivia.private@example.com", avatarUrl: null },
		]);
	});

	it("includes the email for an admin's token only with the admin scope", async () => {
		const scoped = await listAs(Role.ADMIN, ["content:read"]);
		expect(scoped.status).toBe(200);
		expect(scoped.items).toEqual([{ id: ownerId, name: "Olivia", avatarUrl: null }]);

		const full = await listAs(Role.ADMIN, ["admin"]);
		expect(full.items[0]?.email).toBe("olivia.private@example.com");
	});

	it("still refuses a subscriber", async () => {
		const { status, items } = await listAs(Role.SUBSCRIBER);

		expect(status).toBe(403);
		expect(items).toEqual([]);
	});
});
