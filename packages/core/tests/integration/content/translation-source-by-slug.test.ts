import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as createContent } from "../../../src/astro/routes/api/content/[collection]/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	createTestRuntime,
	extractJson,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const AUTHOR_ID = "user_author";
// A slugless seed entry is stored under its seed id, which is not a ULID.
const SEED_ID = "seeded-plan";

describe("creating a translation when translationOf matches one entry's slug and another's id", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let ownEntryId: string;
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
		const own = await repo.create({
			type: "post",
			slug: SEED_ID,
			data: { title: "Own entry" },
			authorId: AUTHOR_ID,
		});
		ownEntryId = own.id;
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		harness = undefined;
		await teardownTestDatabase(db);
	});

	async function expectLinkedToOwnEntry(createdId: string) {
		const created = await repo.findById("post", createdId);
		const own = await repo.findById("post", ownEntryId);
		expect(created?.translationGroup).toBe(own?.translationGroup);
		expect(await repo.findTranslations("post", SEED_ID)).toHaveLength(1);
	}

	it("REST links the translation to the entry the permission check used", async () => {
		const url = "http://localhost/_emdash/api/content/post";
		const response = await createContent({
			params: { collection: "post" },
			request: new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					data: { title: "Traduction" },
					locale: "fr",
					translationOf: SEED_ID,
				}),
			}),
			url: new URL(url),
			locals: {
				emdash: createTestRuntime(db),
				user: { id: AUTHOR_ID, role: Role.AUTHOR },
			},
		} as unknown as APIContext);

		expect(response.status).toBe(201);
		const body = (await response.json()) as { data: { item: { id: string } } };
		await expectLinkedToOwnEntry(body.data.item.id);
	});

	it("MCP content_create links the translation to the entry the permission check used", async () => {
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

		expect(result.isError).toBeFalsy();
		const { item } = extractJson<{ item: { id: string } }>(result);
		await expectLinkedToOwnEntry(item.id);
	});
});
