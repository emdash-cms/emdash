import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

const MEDIA_ID = "01KPD97MWB5DVHBHK69TW55KY3";
const MEDIA_URL = `/_emdash/api/media/file/${MEDIA_ID}`;

describe("Loader media src", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const registry = new SchemaRegistry(db);
		await registry.createField("post", {
			slug: "hero",
			label: "Hero",
			type: "image",
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("resolves bare media ID in src to a file URL", async () => {
		await handleContentCreate(db, "post", {
			data: {
				title: "Test",
				hero: { provider: "local", id: "", src: MEDIA_ID },
			},
			status: "published",
		});

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post" } }),
		);

		const hero = result.entries![0]!.data.hero as Record<string, unknown>;
		expect(hero.id).toBe(MEDIA_ID);
		expect(hero.src).toBe(MEDIA_URL);
	});

	it("resolves bare media ID in loadEntry", async () => {
		await handleContentCreate(db, "post", {
			data: {
				title: "Test",
				hero: { provider: "local", id: "", src: MEDIA_ID },
			},
			status: "published",
		});

		const loader = emdashLoader();
		const collection = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post" } }),
		);
		const entryId = collection.entries![0]!.data.id as string;

		const entry = await runWithContext({ editMode: false, db }, () =>
			loader.loadEntry!({ filter: { type: "post", id: entryId } }),
		);

		const hero = entry!.data.hero as Record<string, unknown>;
		expect(hero.id).toBe(MEDIA_ID);
		expect(hero.src).toBe(MEDIA_URL);
	});

	it("does not rewrite an existing local media URL", async () => {
		await handleContentCreate(db, "post", {
			data: {
				title: "Test",
				hero: { provider: "local", id: "", src: MEDIA_URL },
			},
			status: "published",
		});

		const loader = emdashLoader();
		const result = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post" } }),
		);

		const hero = result.entries![0]!.data.hero as Record<string, unknown>;
		expect(hero.id).toBe(MEDIA_ID);
		expect(hero.src).toBe(MEDIA_URL);
	});

	it("resolves bare media ID in revision-backed loadEntry", async () => {
		const createResult = await handleContentCreate(db, "post", {
			data: {
				title: "Published",
				hero: { provider: "local", id: "", src: MEDIA_URL },
			},
			status: "published",
		});
		if (!createResult.success) throw new Error("Failed to create post");

		const revisionRepo = new RevisionRepository(db);
		const revision = await revisionRepo.create({
			collection: "post",
			entryId: createResult.data!.item.id,
			data: {
				title: "Draft",
				hero: { provider: "local", id: "", src: MEDIA_ID },
			},
		});

		const loader = emdashLoader();
		const entry = await runWithContext({ editMode: false, db }, () =>
			loader.loadEntry!({
				filter: {
					type: "post",
					id: createResult.data!.item.id,
					revisionId: revision.id,
				},
			}),
		);

		const hero = entry!.data.hero as Record<string, unknown>;
		expect(hero.id).toBe(MEDIA_ID);
		expect(hero.src).toBe(MEDIA_URL);
	});
});
