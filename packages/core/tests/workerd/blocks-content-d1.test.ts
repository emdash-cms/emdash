import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { BlockTypeRegistry } from "../../src/schema/block-type-registry.js";
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
});

afterAll(async () => {
	await db.destroy();
});

describe("blocks content on D1", () => {
	it("normalizes and updates versioned block values", async () => {
		const blocks = new BlockTypeRegistry(db);
		const schema = new SchemaRegistry(db);
		await blocks.createBlockType({
			slug: "hero",
			label: "Hero",
			fields: [{ slug: "heading", label: "Heading", type: "string", required: true }],
		});
		await schema.createCollection({ slug: "pages", label: "Pages" });
		await schema.createField("pages", {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: ["hero"] },
		});
		const runtime = createTestRuntime(db);

		const created = await runtime.handleContentCreate("pages", {
			slug: "home",
			data: { layout: [{ _type: "hero", heading: "Before" }] },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;
		const block = (created.data.item.data.layout as Array<Record<string, unknown>>)[0]!;
		const updated = await runtime.handleContentUpdate("pages", created.data.item.id, {
			data: { layout: [{ ...block, heading: "After" }] },
		});

		expect(updated.success).toBe(true);
		if (updated.success) {
			expect(updated.data.item.data.layout).toEqual([
				expect.objectContaining({
					_type: "hero",
					_version: 1,
					_key: block._key,
					heading: "After",
				}),
			]);
		}
	});
});
