import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		collections: [
			{
				slug: "posts",
				label: "Posts",
				fields: [{ slug: "hero", label: "Hero", type: "image" }],
			},
		],
		content: {
			posts: [
				{
					id: "welcome",
					slug: "welcome",
					data: {
						hero: { id: "welcome-image", provider: "local", mimeType: "image/webp" },
					},
				},
			],
		},
	},
	userSeed: null,
}));

import { POST as postSetup } from "../../../src/astro/routes/api/setup/index.js";
import type { Database } from "../../../src/database/types.js";
import { verifyMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function setupContext(db: Kysely<Database>, enableMediaUsageTracking?: boolean): APIContext {
	const url = new URL("http://localhost:4321/_emdash/api/setup");
	return {
		url,
		request: new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "Fresh site",
				includeContent: true,
				...(enableMediaUsageTracking === undefined ? {} : { enableMediaUsageTracking }),
			}),
		}),
		locals: { emdash: { db, config: {}, storage: undefined } },
	} as unknown as APIContext;
}

describe("POST /setup media usage tracking", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("activates capture before applying a fresh seed", async () => {
		const response = await postSetup(setupContext(db, true));

		expect(response.status).toBe(200);
		const activation = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
		expect(activation.state).toBe("active");
		const collection = await new SchemaRegistry(db).getCollection("posts");
		if (!collection) throw new Error("Expected seeded posts collection");
		expect(
			await verifyMediaUsageCaptureTriggers(db, {
				collectionId: collection.id,
				collectionSlug: collection.slug,
			}),
		).toBe(true);
		expect(
			await db
				.selectFrom("_emdash_media_usage_work")
				.select(["collection_id", "state", "attempt_count"])
				.execute(),
		).toEqual([{ collection_id: collection.id, state: "pending", attempt_count: 0 }]);
	});

	it("keeps omitted API input backwards compatible", async () => {
		const response = await postSetup(setupContext(db));

		expect(response.status).toBe(200);
		const activation = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
		expect(activation.state).toBe("expanded");
	});

	it("rejects pre-seed activation after collections already exist", async () => {
		await new SchemaRegistry(db).createCollection({ slug: "existing", label: "Existing" });

		const response = await postSetup(setupContext(db, true));

		expect(response.status).toBe(409);
		const activation = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirstOrThrow();
		expect(activation.state).toBe("expanded");
	});
});
