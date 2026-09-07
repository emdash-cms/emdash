import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { listColumns, resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * The loader's entry read at the widest collection D1 can still return.
 *
 * D1 caps a result set at 100 columns. `loadEntry` selects `c.*` plus the
 * folded hydration columns, so 96 table columns is the widest collection that
 * still leaves them room under the cap.
 */
const COLLECTION = "wide_d1";
/** Takes `ec_wide_d1` to LOADABLE_TABLE_WIDTH alongside `title`. */
const USER_FIELD_COUNT = 80;
/** 15 system columns plus `title` plus USER_FIELD_COUNT. */
const LOADABLE_TABLE_WIDTH = 96;

let db: Kysely<Database>;
let seoRepo: SeoRepository;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: COLLECTION,
		label: "Wide D1",
		labelSingular: "Wide D1 Entry",
	});
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	for (let i = 1; i <= USER_FIELD_COUNT; i++) {
		await registry.createField(COLLECTION, {
			slug: `field_${i}`,
			label: `Field ${i}`,
			type: "string",
		});
	}
	await db
		.updateTable("_emdash_collections")
		.set({ has_seo: 1 })
		.where("slug", "=", COLLECTION)
		.execute();

	seoRepo = new SeoRepository(db);
});

afterAll(async () => {
	await db.destroy();
});

function load(idOrSlug: string) {
	const loader = emdashLoader();
	return runWithContext({ db, editMode: false }, () =>
		loader.loadEntry!({ filter: { type: COLLECTION, id: idOrSlug } }),
	);
}

async function createEntry(title: string): Promise<{ id: string; slug: string }> {
	const data: Record<string, string> = { title };
	for (let i = 1; i <= USER_FIELD_COUNT; i++) data[`field_${i}`] = `value-${i}`;
	const result = await handleContentCreate(db, COLLECTION, { data, status: "published" });
	if (!result.success) throw new Error(`Failed to create entry: ${JSON.stringify(result)}`);
	const item = result.data!.item;
	return { id: item.id, slug: item.slug! };
}

describe("loader on a wide collection on D1", () => {
	it("builds the collection at the loadable width", async () => {
		expect(await listColumns(db, `ec_${COLLECTION}`)).toHaveLength(LOADABLE_TABLE_WIDTH);
	});

	it("rejects five flat columns on top of c.* at this width", async () => {
		// Five alias columns on top of `c.*` ask D1 for 101 columns here, and
		// D1 refuses the statement rather than truncating it.
		await expect(
			sql
				.raw(
					`SELECT c.*, s.seo_no_index, s.seo_canonical, s.seo_title, s.seo_description, s.seo_image
					 FROM ec_${COLLECTION} c
					 LEFT JOIN _emdash_seo s ON s.collection = '${COLLECTION}' AND s.content_id = c.id`,
				)
				.execute(db),
		).rejects.toThrow(/too many columns in result set/);
	});

	it("loads an entry at the loadable width", async () => {
		const { slug } = await createEntry("Wide Entry");

		const loaded = await load(slug);

		const data = (loaded as { data: Record<string, unknown> }).data;
		expect(data.title).toBe("Wide Entry");
		expect(data.field_1).toBe("value-1");
		expect(data.field_80).toBe("value-80");
	});

	it("still attaches data.seo at the loadable width", async () => {
		const { id, slug } = await createEntry("Wide With SEO");
		await seoRepo.upsert(COLLECTION, id, {
			noIndex: true,
			canonical: "https://example.com/wide",
			title: "Wide SEO Title",
		});

		const loaded = await load(slug);

		const seo = (loaded as { data: Record<string, unknown> }).data.seo as Record<string, unknown>;
		expect(seo).toBeDefined();
		expect(seo.noIndex).toBe(true);
		expect(seo.canonical).toBe("https://example.com/wide");
		expect(seo.title).toBe("Wide SEO Title");
	});

	it("omits data.seo at the loadable width when no SEO row exists", async () => {
		const { slug } = await createEntry("No SEO");

		const loaded = await load(slug);

		expect((loaded as { data: Record<string, unknown> }).data.seo).toBeUndefined();
	});
});
