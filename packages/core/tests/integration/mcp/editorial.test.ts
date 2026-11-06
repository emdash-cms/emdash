import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	currentRev,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const USER = "user_contributor";

function block(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
	};
}

interface Thread {
	id: string;
	status: string;
	anchor: Record<string, unknown>;
	comments: Array<{ body: string }>;
}

describe("MCP editorial tools", () => {
	let db: Kysely<Database>;
	let harness: McpHarness | undefined;
	let entryId: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values({
				id: USER,
				email: "contributor@example.com",
				name: "Con",
				role: Role.CONTRIBUTOR,
				email_verified: 1,
			})
			.execute();
		const item = await new ContentRepository(db).create({
			type: "post",
			data: {
				title: "Fish",
				content: [block("b1", "One fish, two fish."), block("b2", "Red fish, blue fish.")],
			},
			authorId: USER,
		});
		entryId = item.id;
	});

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
		await teardownTestDatabase(db);
	});

	async function connect(role: number = Role.CONTRIBUTOR, tokenScopes?: string[]) {
		harness = await connectMcpHarness({ db, userId: USER, userRole: role, tokenScopes });
		return harness.client;
	}

	function call(name: string, args: Record<string, unknown>) {
		return harness!.client.callTool({
			name,
			arguments: { collection: "post", id: entryId, ...args },
		});
	}

	it("anchors a thread to a quote in a rich text field", async () => {
		await connect();

		const created = extractJson<Thread>(
			await call("editorial_thread_create", {
				body: "Which blue?",
				field: "content",
				quote: "blue",
			}),
		);

		expect(created.anchor).toEqual({
			type: "text",
			field: "content",
			blockKey: "b2",
			start: 10,
			end: 14,
			quote: "blue",
			prefix: "Red fish, ",
			suffix: " fish.",
		});
	});

	it("asks for context when a quote is repeated, and refuses one that isn't there", async () => {
		await connect();

		const repeated = await call("editorial_thread_create", {
			body: "Too many fish",
			field: "content",
			quote: "fish",
		});
		expect(repeated.isError).toBe(true);
		expect(extractText(repeated)).toMatch(/^\[VALIDATION_ERROR\].*prefix/);

		const picked = extractJson<Thread>(
			await call("editorial_thread_create", {
				body: "This one",
				field: "content",
				quote: "fish",
				prefix: "blue ",
			}),
		);
		expect(picked.anchor).toMatchObject({ blockKey: "b2", start: 15 });

		const missing = await call("editorial_thread_create", {
			body: "Where?",
			field: "content",
			quote: "whale",
		});
		expect(extractText(missing)).toMatch(/^\[VALIDATION_ERROR\]/);
	});

	it("finds a quote in the draft revision, not only the saved columns", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "story",
			label: "Stories",
			labelSingular: "Story",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("story", { slug: "body", label: "Body", type: "portableText" });
		const client = await connect(Role.EDITOR);
		const story = extractJson<{ item: { id: string } }>(
			await client.callTool({
				name: "content_create",
				arguments: { collection: "story", data: { body: [block("b1", "One fish.")] } },
			}),
		).item;
		await client.callTool({
			name: "content_update",
			arguments: {
				collection: "story",
				id: story.id,
				_rev: await currentRev(client, "story", story.id),
				data: { body: [block("b1", "One fish, two fish, three fish.")] },
			},
		});
		const columns = await new ContentRepository(db).findById("story", story.id);
		expect(JSON.stringify(columns?.data.body)).not.toContain("three");

		const created = extractJson<Thread>(
			await client.callTool({
				name: "editorial_thread_create",
				arguments: {
					collection: "story",
					id: story.id,
					body: "Count again",
					field: "body",
					quote: "three",
				},
			}),
		);

		expect(created.anchor).toMatchObject({ blockKey: "b1", quote: "three", start: 20 });
	});

	it("lists, replies to and resolves threads", async () => {
		await connect();
		const thread = extractJson<Thread>(
			await call("editorial_thread_create", { body: "Whole post note" }),
		);
		expect(thread.anchor).toEqual({ type: "entry" });

		const replied = extractJson<Thread>(
			await call("editorial_comment_create", { threadId: thread.id, body: "Done" }),
		);
		expect(replied.comments.map((comment) => comment.body)).toEqual(["Whole post note", "Done"]);

		const resolved = extractJson<Thread>(
			await call("editorial_thread_resolve", { threadId: thread.id }),
		);
		expect(resolved.status).toBe("resolved");

		const open = extractJson<{ items: Thread[] }>(await call("editorial_thread_list", {}));
		expect(open.items).toEqual([]);
		const all = extractJson<{ items: Thread[] }>(
			await call("editorial_thread_list", { status: "all" }),
		);
		expect(all.items.map((item) => item.id)).toEqual([thread.id]);
	});

	it("refuses subscribers, and tokens that can't write content", async () => {
		await connect(Role.SUBSCRIBER);
		const subscriber = await call("editorial_thread_list", {});
		expect(extractText(subscriber)).toMatch(/^\[INSUFFICIENT_PERMISSIONS\]/);
		await harness!.cleanup();

		await connect(Role.CONTRIBUTOR, ["content:read"]);
		const readOnly = await call("editorial_thread_create", { body: "Hi" });
		expect(extractText(readOnly)).toMatch(/^\[INSUFFICIENT_SCOPE\]/);
		expect((await call("editorial_thread_list", {})).isError).toBeFalsy();
	});
});
