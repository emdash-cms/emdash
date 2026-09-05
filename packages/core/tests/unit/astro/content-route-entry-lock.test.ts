/**
 * The content write routes must refuse a write against another editor's live
 * edit lock, and must honour the caller's opt-out.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
	PUT as updateContent,
	DELETE as deleteContent,
} from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { POST as discardDraft } from "../../../src/astro/routes/api/content/[collection]/[id]/discard-draft.js";
import { POST as publishContent } from "../../../src/astro/routes/api/content/[collection]/[id]/publish.js";
import {
	POST as scheduleContent,
	DELETE as unscheduleContent,
} from "../../../src/astro/routes/api/content/[collection]/[id]/schedule.js";
import { POST as unpublishContent } from "../../../src/astro/routes/api/content/[collection]/[id]/unpublish.js";
import { EntryLockRepository } from "../../../src/database/repositories/entry-locks.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const HOLDER = "user-ada";
const WRITER = "user-linus";
const ENTRY_ID = "01JXENTRY0000000000000000";

const ROUTES = [
	{ name: "PUT", handler: updateContent, method: "PUT", path: "", body: {} },
	{ name: "DELETE", handler: deleteContent, method: "DELETE", path: "", body: undefined },
	{ name: "publish", handler: publishContent, method: "POST", path: "/publish", body: {} },
	{ name: "unpublish", handler: unpublishContent, method: "POST", path: "/unpublish", body: {} },
	{
		name: "discard-draft",
		handler: discardDraft,
		method: "POST",
		path: "/discard-draft",
		body: {},
	},
	{
		name: "schedule",
		handler: scheduleContent,
		method: "POST",
		path: "/schedule",
		body: { scheduledAt: "2030-01-01T00:00:00.000Z" },
	},
	{
		name: "unschedule",
		handler: unscheduleContent,
		method: "DELETE",
		path: "/schedule",
		body: undefined,
	},
] as const;

describe("content write routes — entry edit lock", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await new SchemaRegistry(db).createCollection({ slug: "posts", label: "Posts" });
		await db
			.insertInto("users")
			.values([
				{ id: HOLDER, email: "ada@example.com", name: "Ada", role: 40, email_verified: 1 },
				{ id: WRITER, email: "linus@example.com", name: "Linus", role: 40, email_verified: 1 },
			])
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function callRoute(
		route: (typeof ROUTES)[number],
		options: { overrideLock?: boolean } = {},
	): Promise<Response> {
		const handleContentGet = vi.fn().mockResolvedValue({
			success: true,
			data: { item: { id: ENTRY_ID, authorId: WRITER }, _rev: "rev1" },
		});
		// DELETE takes no body, so its opt-out rides on the query string.
		const query = options.overrideLock && route.method === "DELETE" ? "?overrideLock=true" : "";
		const url = `http://localhost/_emdash/api/content/posts/${ENTRY_ID}${route.path}${query}`;
		const request = new Request(url, {
			method: route.method,
			headers: { "Content-Type": "application/json" },
			body:
				route.body === undefined
					? undefined
					: JSON.stringify({
							...route.body,
							...(options.overrideLock ? { overrideLock: true } : {}),
						}),
		});
		const okItem = { success: true, data: { item: {} } };
		return route.handler({
			params: { collection: "posts", id: ENTRY_ID },
			request,
			url: new URL(url),
			locals: {
				user: { id: WRITER, role: Role.EDITOR },
				emdash: {
					db,
					handleContentGet,
					handleContentUpdate: vi.fn().mockResolvedValue(okItem),
					handleContentPublish: vi.fn().mockResolvedValue(okItem),
					handleContentUnpublish: vi.fn().mockResolvedValue(okItem),
					handleContentDiscardDraft: vi.fn().mockResolvedValue(okItem),
					handleContentSchedule: vi.fn().mockResolvedValue(okItem),
					handleContentUnschedule: vi.fn().mockResolvedValue(okItem),
					handleContentDelete: vi.fn().mockResolvedValue({ success: true, data: {} }),
				},
			},
			cache: { enabled: false, invalidate: vi.fn() },
		} as unknown as APIContext);
	}

	async function giveLockTo(userId: string): Promise<void> {
		await new EntryLockRepository(db).acquire({
			collection: "posts",
			entryId: ENTRY_ID,
			userId,
			token: `tab-${userId}`,
			leaseSeconds: 300,
		});
	}

	for (const route of ROUTES) {
		it(`${route.name} refuses a write against another editor's lock`, async () => {
			await giveLockTo(HOLDER);

			const response = await callRoute(route);

			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				success: false,
				error: {
					code: "ENTRY_LOCKED",
					message: "Ada is holding this entry",
					details: { userId: HOLDER, userName: "Ada" },
				},
			});
		});

		it(`${route.name} writes through the lock when the caller opts out`, async () => {
			await giveLockTo(HOLDER);

			const response = await callRoute(route, { overrideLock: true });

			expect(response.status).toBe(200);
		});

		it(`${route.name} writes freely when nobody holds the entry`, async () => {
			const response = await callRoute(route);

			expect(response.status).toBe(200);
		});
	}

	it("keeps the writer's own lease alive across a save", async () => {
		await giveLockTo(WRITER);
		const repo = new EntryLockRepository(db);
		await db
			.updateTable("_emdash_entry_locks")
			.set({ expires_at: new Date(Date.now() + 30_000).toISOString() })
			.where("entry_id", "=", ENTRY_ID)
			.execute();
		const before = (await repo.findLive("posts", ENTRY_ID))!.expiresAt;

		const response = await callRoute(ROUTES[0]);

		expect(response.status).toBe(200);
		const after = await repo.findLive("posts", ENTRY_ID);
		expect(after!.expiresAt > before).toBe(true);
	});
});
