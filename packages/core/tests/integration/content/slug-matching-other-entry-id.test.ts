import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as createContent } from "../../../src/astro/routes/api/content/[collection]/index.js";
import { POST as restoreRevision } from "../../../src/astro/routes/api/revisions/[revisionId]/restore.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	createTestRuntime,
	extractJson,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const AUTHOR_ID = "user_author";
const EDITOR_ID = "user_editor";
// A slugless seed entry is stored under its seed id, which is not a ULID.
const SEED_ID = "seeded-plan";

type Actor = { id: string; role: (typeof Role)[keyof typeof Role] };
const author: Actor = { id: AUTHOR_ID, role: Role.AUTHOR };
const editor: Actor = { id: EDITOR_ID, role: Role.EDITOR };

describe("an entry id that is also another entry's slug", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let harness: McpHarness | undefined;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
		await repo.create({
			id: SEED_ID,
			type: "post",
			slug: null,
			data: { title: "Seeded Post" },
			status: "published",
		});
		await repo.create({
			type: "post",
			slug: SEED_ID,
			data: { title: "Own entry" },
			authorId: AUTHOR_ID,
		});
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		harness = undefined;
		await teardownTestDatabase(db);
	});

	function context(url: string, params: Record<string, string>, body: unknown, user: Actor) {
		return {
			params,
			request: new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			url: new URL(url),
			locals: { emdash: createTestRuntime(db), user },
		} as unknown as APIContext;
	}

	function createTranslation(user: Actor) {
		return createContent(
			context(
				"http://localhost/_emdash/api/content/post",
				{ collection: "post" },
				{ data: { title: "Traduction" }, locale: "fr", translationOf: SEED_ID },
				user,
			),
		);
	}

	async function seededRevision() {
		return new RevisionRepository(db).create({
			collection: "post",
			entryId: SEED_ID,
			data: { title: "Earlier title" },
		});
	}

	function restore(revisionId: string, user: Actor) {
		return restoreRevision(
			context(
				`http://localhost/_emdash/api/revisions/${revisionId}/restore`,
				{ revisionId },
				{},
				user,
			),
		);
	}

	async function seededDraftRevisionId() {
		return (await repo.findById("post", SEED_ID))?.draftRevisionId ?? null;
	}

	describe("translationOf", () => {
		it("REST refuses an author who does not own the entry with that id", async () => {
			const response = await createTranslation(author);

			expect(response.status).toBe(403);
			expect(await repo.findTranslations("post", SEED_ID)).toHaveLength(1);
		});

		it("REST links an editor's translation to the entry with that id", async () => {
			const response = await createTranslation(editor);

			expect(response.status).toBe(201);
			const body = (await response.json()) as { data: { item: { translationGroup: string } } };
			expect(body.data.item.translationGroup).toBe(SEED_ID);
			expect(await repo.findTranslations("post", SEED_ID)).toHaveLength(2);
		});

		it("MCP content_create refuses an author who does not own the entry with that id", async () => {
			harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

			const result = await harness.client.callTool({
				name: "content_create",
				arguments: {
					collection: "post",
					data: { title: "Traduction" },
					locale: "fr",
					translationOf: SEED_ID,
				},
			});

			expect(result.isError).toBe(true);
			expect(await repo.findTranslations("post", SEED_ID)).toHaveLength(1);
		});

		it("MCP content_create links an editor's translation to the entry with that id", async () => {
			harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });

			const result = await harness.client.callTool({
				name: "content_create",
				arguments: {
					collection: "post",
					data: { title: "Traduction" },
					locale: "fr",
					translationOf: SEED_ID,
				},
			});

			expect(result.isError).toBeFalsy();
			const { item } = extractJson<{ item: { translationGroup: string } }>(result);
			expect(item.translationGroup).toBe(SEED_ID);
		});
	});

	describe("revision restore", () => {
		it("REST refuses an author who does not own the entry with that id", async () => {
			const revision = await seededRevision();

			const response = await restore(revision.id, author);

			expect(response.status).toBe(403);
			expect(await seededDraftRevisionId()).toBeNull();
		});

		it("REST lets an editor restore a revision of the entry with that id", async () => {
			const revision = await seededRevision();

			const response = await restore(revision.id, editor);

			expect(response.status).toBe(200);
			expect(await seededDraftRevisionId()).not.toBeNull();
		});

		it("MCP revision_restore refuses an author who does not own the entry with that id", async () => {
			const revision = await seededRevision();
			harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

			const result = await harness.client.callTool({
				name: "revision_restore",
				arguments: { revisionId: revision.id },
			});

			expect(result.isError).toBe(true);
			expect(await seededDraftRevisionId()).toBeNull();
		});

		it("MCP revision_restore lets an editor restore a revision of the entry with that id", async () => {
			const revision = await seededRevision();
			harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });

			const result = await harness.client.callTool({
				name: "revision_restore",
				arguments: { revisionId: revision.id },
			});

			expect(result.isError).toBeFalsy();
			expect(await seededDraftRevisionId()).not.toBeNull();
		});
	});
});
