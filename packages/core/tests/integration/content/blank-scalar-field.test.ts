import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("blank values in url, datetime and number fields", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "events", label: "Events" });
		await registry.createField("events", { slug: "title", label: "Title", type: "string" });
		await registry.createField("events", { slug: "website", label: "Website", type: "url" });
		await registry.createField("events", { slug: "starts_at", label: "Starts", type: "datetime" });
		await registry.createField("events", {
			slug: "price",
			label: "Price",
			type: "number",
			validation: { min: 1 },
		});
		await registry.createField("events", { slug: "seats", label: "Seats", type: "integer" });
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("saves blank strings as null on create", async () => {
		const result = await runtime.handleContentCreate("events", {
			slug: "e1",
			data: { title: "e1", website: "", starts_at: "", price: "  ", seats: "" },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		const row = await sql<Record<string, unknown>>`
			SELECT website, starts_at, price, seats FROM ${sql.ref("ec_events")}
			WHERE id = ${result.data.item.id}
		`.execute(ctx.db);
		expect(row.rows[0]).toEqual({ website: null, starts_at: null, price: null, seats: null });
	});

	it("clears a url and a datetime when an update sends them blank", async () => {
		const created = await runtime.handleContentCreate("events", {
			slug: "e2",
			data: {
				title: "e2",
				website: "https://example.com",
				starts_at: "2026-05-01T10:00:00.000Z",
			},
		});
		if (!created.success) throw new Error("setup failed");
		const { id } = created.data.item;

		const updated = await runtime.handleContentUpdate("events", id, {
			data: { ...created.data.item.data, website: "", starts_at: "" },
		});

		expect(updated.success).toBe(true);
		if (!updated.success) return;
		expect(updated.data.item.data.website).toBeNull();
		expect(updated.data.item.data.starts_at).toBeNull();
	});

	it("saves an entry read back with a stored blank url", async () => {
		const created = await runtime.handleContentCreate("events", {
			slug: "e3",
			data: { title: "e3" },
		});
		if (!created.success) throw new Error("setup failed");
		const { id } = created.data.item;
		await sql`UPDATE ${sql.ref("ec_events")} SET website = ${""} WHERE id = ${id}`.execute(ctx.db);

		const loaded = await runtime.handleContentGet("events", id);
		if (!loaded.success) throw new Error("load failed");
		expect(loaded.data.item.data.website).toBe("");

		const updated = await runtime.handleContentUpdate("events", id, {
			data: { ...loaded.data.item.data, title: "e3 edited" },
		});

		expect(updated.success).toBe(true);
		if (!updated.success) return;
		expect(updated.data.item.data.website).toBeNull();
	});

	it("keeps a blank string in a string field", async () => {
		const result = await runtime.handleContentCreate("events", {
			slug: "e4",
			data: { title: "" },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data.title).toBe("");
	});

	it("still rejects a blank url on a required field", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "links", label: "Links" });
		await registry.createField("links", {
			slug: "href",
			label: "Link",
			type: "url",
			required: true,
		});

		const result = await runtime.handleContentCreate("links", {
			slug: "l1",
			data: { href: "" },
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.details?.issues).toEqual([
			expect.objectContaining({ path: "href", code: "required" }),
		]);
	});
});
