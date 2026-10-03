import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { ContentMutationConflictError } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { definePlugin } from "../../src/plugins/define-plugin.js";
import type { ResolvedPlugin } from "../../src/plugins/types.js";
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
			hasSeo: true,
			...(collection === "pages" ? { supports: [] } : {}),
		});
		await registry.createField(collection, { slug: "title", label: "Title", type: "string" });
	}
});

afterAll(async () => {
	await db.destroy();
});

it("accepts only one D1 write with the same revision precondition", async () => {
	const repo = new ContentRepository(db);
	const original = await repo.create({ type: "pages", data: { title: "Original" } });
	const results = await Promise.allSettled([
		repo.update("pages", original.id, { data: { title: "Editor A" } }, original),
		repo.update("pages", original.id, { data: { title: "Editor B" } }, original),
	]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(results.find((result) => result.status === "rejected")?.reason).toBeInstanceOf(
		ContentMutationConflictError,
	);
	expect((await repo.findById("pages", original.id))?.version).toBe(original.version + 1);
});

it.each(["posts", "pages"])(
	"rejects a stale save and its SEO side write on D1 %s",
	async (collection) => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const plugin = definePlugin({
			id: "slow-save",
			version: "1.0.0",
			capabilities: ["content:read", "content:write"],
			hooks: {
				"content:beforeSave": {
					handler: async (event) => {
						if (event.content.title === "Editor A") {
							enter();
							await released;
						}
						return event.content;
					},
				},
			},
		}) as ResolvedPlugin;
		const runtime = createTestRuntime(db, { plugins: [plugin] });
		const created = await runtime.handleContentCreate(collection, {
			data: { title: "Original" },
			slug: "entry",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const editorA = runtime.handleContentUpdate(collection, id, {
			data: { title: "Editor A" },
			seo: { title: "Editor A SEO" },
			_rev: created.data!._rev,
		});
		await entered;
		try {
			const editorB = await runtime.handleContentUpdate(collection, id, {
				data: { title: "Editor B" },
				seo: { title: "Editor B SEO" },
				_rev: created.data!._rev,
			});
			expect(editorB.success).toBe(true);
		} finally {
			release();
		}
		expect(await editorA).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		const stored = await runtime.handleContentGet(collection, id);
		expect(stored.data!.item.data.title).toBe("Editor B");
		expect(stored.data!.item.seo?.title).toBe("Editor B SEO");
	},
);

it("keeps blind D1 writes backwards compatible", async () => {
	const repo = new ContentRepository(db);
	const original = await repo.create({ type: "pages", data: { title: "Original" } });
	await repo.update("pages", original.id, { data: { title: "First" } });
	await repo.update("pages", original.id, { data: { title: "Second" } });
	expect((await repo.findById("pages", original.id))?.data.title).toBe("Second");
});

it("finishes draft bookkeeping when a D1 SEO write fails after staging", async () => {
	const runtime = createTestRuntime(db);
	const created = await runtime.handleContentCreate("posts", {
		data: { title: "Original" },
		slug: "entry",
	});
	const id = created.data!.item.id;
	const autosaved = await runtime.handleContentUpdate("posts", id, {
		data: { title: "First autosave" },
		skipRevision: true,
		_rev: created.data!._rev,
	});
	expect(autosaved.success).toBe(true);
	const previousDraft = autosaved.data!.item.draftRevisionId!;
	await sql`
		CREATE TRIGGER fail_content_save_seo
		BEFORE INSERT ON _emdash_seo
		WHEN NEW.seo_title = 'Rejected SEO'
		BEGIN
			SELECT RAISE(FAIL, 'forced SEO failure');
		END
	`.execute(db);

	const result = await runtime.handleContentUpdate("posts", id, {
		data: { title: "Committed draft" },
		seo: { title: "Rejected SEO" },
		skipRevision: true,
		_rev: autosaved.data!._rev,
	});
	expect(result).toMatchObject({ success: false, error: { code: "CONTENT_UPDATE_ERROR" } });
	const stored = await runtime.handleContentGet("posts", id);
	expect(stored.data!.item.data.title).toBe("Committed draft");
	expect(stored.data!.item.draftRevisionId).not.toBe(previousDraft);
	expect(await new RevisionRepository(db).findById(previousDraft)).toBeNull();
});
