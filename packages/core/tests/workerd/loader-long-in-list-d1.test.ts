import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * D1 refuses a statement with more than 100 bound parameters, so a `where`
 * array longer than that used to fail the whole collection query.
 */
const COLLECTION = "long_in_d1";

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Long IN" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
	await registry.createField(COLLECTION, { slug: "series", label: "Series", type: "string" });
	await registry.createField(COLLECTION, { slug: "edition", label: "Edition", type: "string" });
	for (let i = 0; i < 130; i++) {
		const result = await handleContentCreate(db, COLLECTION, {
			data: { title: `Entry ${i}`, series: `s${i}`, edition: `e${i}` },
			status: "published",
			publishedAt: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
		});
		if (!result.success) throw new Error("Failed to create entry");
	}
});

afterAll(async () => {
	await db.destroy();
});

async function load(
	where: Record<string, string[]>,
	extra: { limit?: number; offset?: number } = {},
) {
	const result = await runWithContext({ db, editMode: false }, () =>
		emdashLoader().loadCollection!({
			filter: { type: COLLECTION, where, orderBy: { published_at: "asc" }, limit: 200, ...extra },
		}),
	);
	if (result.error) throw result.error;
	return result.entries.map((entry) => entry.data.series as string);
}

describe("collection where filters with long arrays on D1", () => {
	it("returns every match for a 120-value list", async () => {
		const series = Array.from({ length: 120 }, (_, i) => `s${i}`);
		expect(await load({ series })).toEqual(series);
	});

	it("pages a long list in the database", async () => {
		const series = Array.from({ length: 120 }, (_, i) => `s${i}`);
		expect(await load({ series }, { limit: 5, offset: 110 })).toEqual([
			"s110",
			"s111",
			"s112",
			"s113",
			"s114",
		]);
	});

	it("handles two long lists in one where", async () => {
		const series = Array.from({ length: 110 }, (_, i) => `s${i}`);
		const edition = Array.from({ length: 60 }, (_, i) => `e${i * 2}`);
		expect(await load({ series, edition })).toEqual(
			Array.from({ length: 55 }, (_, i) => `s${i * 2}`),
		);
	});
});
