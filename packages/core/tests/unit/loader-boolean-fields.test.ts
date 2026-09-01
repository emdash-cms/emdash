import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("Loader boolean field values", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "feature",
			label: "Features",
			labelSingular: "Feature",
		});
		await registry.createField("feature", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("feature", {
			slug: "enabled",
			label: "Enabled",
			type: "boolean",
		});
		await registry.createField("feature", {
			slug: "highlighted",
			label: "Highlighted",
			type: "boolean",
		});
		await registry.createField("feature", {
			slug: "priority",
			label: "Priority",
			type: "integer",
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createFeature(title: string, enabled: boolean, priority: number) {
		const result = await handleContentCreate(ctx.db, "feature", {
			data: { title, enabled, highlighted: null, priority },
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create feature");
		return result.data!.item;
	}

	it("returns booleans from collection loads without coercing integer fields", async () => {
		await createFeature("Enabled", true, 1);
		await createFeature("Disabled", false, 0);

		const loader = emdashLoader();
		const result = await runWithContext({ db: ctx.db }, () =>
			loader.loadCollection!({ filter: { type: "feature" } }),
		);
		const enabled = result.entries.find((entry) => entry.data.title === "Enabled");
		const disabled = result.entries.find((entry) => entry.data.title === "Disabled");

		expect(enabled?.data.enabled).toBe(true);
		expect(disabled?.data.enabled).toBe(false);
		expect(enabled?.data.priority).toBe(1);
		expect(disabled?.data.priority).toBe(0);
		expect(enabled?.data.highlighted).toBeNull();
	});

	it("returns booleans from single-entry loads", async () => {
		const feature = await createFeature("Enabled", true, 1);

		const loader = emdashLoader();
		const result = await runWithContext({ db: ctx.db }, () =>
			loader.loadEntry!({ filter: { type: "feature", id: feature.id } }),
		);

		expect(result).toBeDefined();
		expect((result as { data: Record<string, unknown> }).data.enabled).toBe(true);
	});
});
