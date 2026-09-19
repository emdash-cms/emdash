import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleEntryLockAcquire } from "../../../src/api/handlers/entry-lock.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	currentRev,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADA = "user_ada";
const LINUS = "user_linus";

interface Item {
	id: string;
	status: string;
	scheduledAt?: string | null;
	data: { title?: string };
}

interface LockCase {
	label: string;
	tool: string;
	/** Brings an entry into a state the tool can act on. */
	prepare: () => Promise<string>;
	args: (id: string) => Promise<Record<string, unknown>>;
	/** Asserts that the refused call left the entry as it was. */
	unchanged: (item: Item) => void;
}

describe("MCP content writes against an entry edit lock", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values([
				{ id: ADA, email: "ada@example.com", name: "Ada", role: Role.EDITOR, email_verified: 1 },
				{
					id: LINUS,
					email: "linus@example.com",
					name: "Linus",
					role: Role.EDITOR,
					email_verified: 1,
				},
			])
			.execute();
		harness = await connectMcpHarness({ db, userId: LINUS, userRole: Role.EDITOR });
	});

	afterEach(async () => {
		await harness.cleanup();
		await teardownTestDatabase(db);
	});

	function call(tool: string, args: Record<string, unknown>) {
		return harness.client.callTool({ name: tool, arguments: { collection: "post", ...args } });
	}

	async function succeed(tool: string, args: Record<string, unknown>): Promise<unknown> {
		const result = await call(tool, args);
		expect(result.isError, extractText(result)).toBeFalsy();
		return result;
	}

	async function read(id: string): Promise<Item> {
		return extractJson<{ item: Item }>(await call("content_get", { id })).item;
	}

	function rev(id: string): Promise<string> {
		return currentRev(harness.client, "post", id);
	}

	async function draft(): Promise<string> {
		return extractJson<{ item: Item }>(
			await succeed("content_create", { data: { title: "Draft" } }),
		).item.id;
	}

	async function published(): Promise<string> {
		const id = await draft();
		await succeed("content_publish", { id, _rev: await rev(id) });
		return id;
	}

	async function earlierRevision(id: string): Promise<string> {
		const revision = await new RevisionRepository(db).create({
			collection: "post",
			entryId: id,
			data: { title: "Earlier" },
			authorId: LINUS,
		});
		return revision.id;
	}

	function inAnHour(): string {
		return new Date(Date.now() + 3_600_000).toISOString();
	}

	const cases: LockCase[] = [
		{
			label: "content_update",
			tool: "content_update",
			prepare: draft,
			args: async (id) => ({ id, data: { title: "Agent edit" }, _rev: await rev(id) }),
			unchanged: (item) => expect(item.data.title).toBe("Draft"),
		},
		{
			label: "content_update with a status change",
			tool: "content_update",
			prepare: draft,
			args: async (id) => ({
				id,
				data: { title: "Agent edit" },
				status: "published",
				_rev: await rev(id),
			}),
			unchanged: (item) =>
				expect(item).toMatchObject({ status: "draft", data: { title: "Draft" } }),
		},
		{
			label: "content_delete",
			tool: "content_delete",
			prepare: draft,
			args: async (id) => ({ id }),
			unchanged: (item) => expect(item.status).toBe("draft"),
		},
		{
			label: "content_publish",
			tool: "content_publish",
			prepare: draft,
			args: async (id) => ({ id, _rev: await rev(id) }),
			unchanged: (item) => expect(item.status).toBe("draft"),
		},
		{
			label: "content_unpublish",
			tool: "content_unpublish",
			prepare: published,
			args: async (id) => ({ id, _rev: await rev(id) }),
			unchanged: (item) => expect(item.status).toBe("published"),
		},
		{
			label: "content_schedule",
			tool: "content_schedule",
			prepare: draft,
			args: async (id) => ({ id, scheduledAt: inAnHour() }),
			unchanged: (item) => expect(item.scheduledAt).toBeFalsy(),
		},
		{
			label: "content_unschedule",
			tool: "content_unschedule",
			prepare: async () => {
				const id = await draft();
				await succeed("content_schedule", { id, scheduledAt: inAnHour() });
				return id;
			},
			args: async (id) => ({ id }),
			unchanged: (item) => expect(item.scheduledAt).toBeTruthy(),
		},
		{
			label: "content_discard_draft",
			tool: "content_discard_draft",
			prepare: async () => {
				const id = await published();
				await succeed("content_update", { id, data: { title: "Pending" }, _rev: await rev(id) });
				return id;
			},
			args: async (id) => ({ id, _rev: await rev(id) }),
			unchanged: (item) => expect(item.data.title).toBe("Pending"),
		},
		{
			label: "revision_restore",
			tool: "revision_restore",
			prepare: draft,
			args: async (id) => ({ revisionId: await earlierRevision(id) }),
			unchanged: (item) => expect(item.data.title).toBe("Draft"),
		},
	];

	describe.each(cases)("$label", ({ tool, prepare, args, unchanged }) => {
		it("is refused while another user holds the entry, naming them", async () => {
			const id = await prepare();
			await handleEntryLockAcquire(db, "post", id, ADA);

			const result = await call(tool, await args(id));

			expect(result.isError).toBe(true);
			expect(extractText(result)).toBe("[ENTRY_LOCKED] Ada is holding this entry");
			expect(result._meta).toMatchObject({
				code: "ENTRY_LOCKED",
				details: { userId: ADA, userName: "Ada" },
			});
			unchanged(await read(id));
		});

		it("goes through with overrideLock", async () => {
			const id = await prepare();
			await handleEntryLockAcquire(db, "post", id, ADA);

			const result = await call(tool, { ...(await args(id)), overrideLock: true });

			expect(result.isError, extractText(result)).toBeFalsy();
		});
	});

	it("lets the caller write to an entry they hold the lock on", async () => {
		const id = await draft();
		await handleEntryLockAcquire(db, "post", id, LINUS);

		await succeed("content_update", { id, data: { title: "Own edit" }, _rev: await rev(id) });

		expect((await read(id)).data.title).toBe("Own edit");
	});

	it("reports a missing permission before the lock, so the holder is not named", async () => {
		const id = await draft();
		await handleEntryLockAcquire(db, "post", id, ADA);
		const author = await connectMcpHarness({ db, userId: "user_author", userRole: Role.AUTHOR });

		try {
			const result = await author.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Not mine" }, _rev: await rev(id) },
			});

			expect(result.isError).toBe(true);
			expect(result._meta).toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
		} finally {
			await author.cleanup();
		}
	});
});
