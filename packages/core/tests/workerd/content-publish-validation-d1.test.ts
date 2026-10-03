import { env } from "cloudflare:test";
import { Kysely, type KyselyPlugin } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentPublish, handleContentUpdate } from "../../src/api/handlers/content.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { MediaRepository } from "../../src/database/repositories/media.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { createTestRuntime } from "../utils/mcp-runtime.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	for (const collection of ["posts", "pages"]) {
		await registry.createCollection({
			slug: collection,
			label: collection,
			supports: collection === "posts" ? ["revisions"] : [],
		});
		await registry.createField(collection, { slug: "title", label: "Title", type: "string" });
	}
});

afterAll(async () => db.destroy());

it.each(["posts", "pages"])("rejects incomplete publication on D1 %s", async (collection) => {
	const runtime = createTestRuntime(db);
	const created = await runtime.handleContentCreate(collection, {
		data: { title: "Original" },
		slug: "entry",
	});
	expect(created.success).toBe(true);
	const id = created.data!.item.id;
	await new SchemaRegistry(db).createField(collection, {
		slug: "summary",
		label: "Summary",
		type: "string",
		required: true,
	});
	const published = await runtime.handleContentPublish(collection, id);
	expect(published).toMatchObject({
		success: false,
		error: {
			code: "VALIDATION_ERROR",
			details: { issues: expect.arrayContaining([expect.objectContaining({ path: "summary" })]) },
		},
	});
	expect(await runtime.handleContentUpdate(collection, id, { status: "published" })).toMatchObject({
		success: false,
		error: { code: "VALIDATION_ERROR" },
	});
	expect((await new ContentRepository(db).findById(collection, id))?.status).toBe("draft");
});

it.each(["posts", "pages"])("rejects disallowed publication media on D1 %s", async (collection) => {
	const runtime = createTestRuntime(db);
	const registry = new SchemaRegistry(db);
	await registry.createField(collection, {
		slug: "attachment",
		label: "Attachment",
		type: "file",
		validation: { allowedMimeTypes: ["application/pdf"] },
	});
	const media = await new MediaRepository(db).create({
		filename: "attachment.pdf",
		mimeType: "application/pdf",
		storageKey: "attachment.pdf",
	});
	const created = await runtime.handleContentCreate(collection, {
		data: { title: "Original", attachment: { id: media.id } },
		slug: "entry",
	});
	expect(created.success).toBe(true);
	const id = created.data!.item.id;
	await registry.updateField(collection, "attachment", {
		validation: { allowedMimeTypes: ["application/zip"] },
	});
	expect(await runtime.handleContentPublish(collection, id)).toMatchObject({
		success: false,
		error: { code: "INVALID_MIME_FOR_FIELD" },
	});
	expect(await runtime.handleContentUpdate(collection, id, { status: "published" })).toMatchObject({
		success: false,
		error: { code: "INVALID_MIME_FOR_FIELD" },
	});
	expect((await new ContentRepository(db).findById(collection, id))?.status).toBe("draft");
});

it.each(["posts", "pages"])(
	"validates actual live reference selections for explicit D1 %s publication",
	async (collection) => {
		const runtime = createTestRuntime(db);
		const created = await runtime.handleContentCreate(collection, {
			data: { title: "Original" },
			slug: "entry",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const targetCollection = collection === "posts" ? "pages" : "posts";
		const target = await new ContentRepository(db).create({
			type: targetCollection,
			data: { title: "Related" },
			slug: "related",
			status: "published",
		});
		const relation = `${collection}_related`;
		await new RelationRepository(db).create({
			slug: relation,
			parentCollection: collection,
			childCollection: targetCollection,
			parentLabel: collection,
			childLabel: targetCollection,
		});
		await new SchemaRegistry(db).createField(collection, {
			slug: "related",
			label: "Related",
			type: "reference",
			required: true,
			validation: { relation, relationSide: "parent", targetCollection },
		});
		expect(
			await runtime.handleContentUpdate(collection, id, { status: "published" }),
		).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR" },
		});
		const references = { related: [target.id] };
		const supplied = await runtime.handleContentUpdate(collection, id, {
			status: "published",
			references,
		});
		if (collection === "posts") {
			expect(supplied).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
			expect((await runtime.handleContentUpdate(collection, id, { references })).success).toBe(
				true,
			);
			expect((await runtime.handleContentPublish(collection, id)).success).toBe(true);
		} else {
			expect(supplied.success).toBe(true);
		}
		expect((await new ContentRepository(db).findById(collection, id))?.status).toBe("published");
	},
);

it.each([
	["posts", "publish"],
	["posts", "status update"],
	["pages", "publish"],
	["pages", "status update"],
])("fences a blind D1 %s %s against a newer saved candidate", async (collection, operation) => {
	const runtime = createTestRuntime(db);
	const created = await runtime.handleContentCreate(collection, {
		data: { title: "Original" },
		slug: "entry",
	});
	expect(created.success).toBe(true);
	const id = created.data!.item.id;
	let snapshots = 0;
	let mutated = false;
	const plugin: KyselyPlugin = {
		transformQuery(args) {
			return args.node;
		},
		async transformResult(args) {
			const row = args.result.rows[0];
			if (row?.id === id && Object.hasOwn(row, "version")) snapshots += 1;
			if (!mutated && snapshots === 2) {
				mutated = true;
				expect(
					(
						await runtime.handleContentUpdate(collection, id, {
							data: { title: "Concurrent edit" },
						})
					).success,
				).toBe(true);
			}
			return args.result;
		},
	};
	const publishDb = db.withPlugin(plugin);
	const result =
		operation === "publish"
			? await handleContentPublish(publishDb, collection, id)
			: await handleContentUpdate(publishDb, collection, id, { status: "published" });
	expect(mutated).toBe(true);
	expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
	const stored = await new ContentRepository(db).findById(collection, id);
	expect(stored?.status).toBe("draft");
	const savedData =
		collection === "posts"
			? (await new RevisionRepository(db).findById(stored!.draftRevisionId!))!.data
			: stored!.data;
	expect(savedData.title).toBe("Concurrent edit");
});
