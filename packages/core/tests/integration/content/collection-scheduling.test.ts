import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentSchedule,
	handleContentUnschedule,
} from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { publishDueContent } from "../../../src/scheduled-publish.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { CollectionSupport } from "../../../src/schema/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type Supports = CollectionSupport[] | undefined;

const future = "2099-01-01T00:00:00.000Z";

describeEachDialect("collection scheduling support", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createCollection(slug: string, supports?: CollectionSupport[]) {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug,
			label: slug,
			labelSingular: slug,
			...(supports === undefined ? {} : { supports }),
		});
		return registry;
	}

	async function createEntry(collection: string) {
		const created = await handleContentCreate(ctx.db, collection, {
			data: {},
			slug: "upcoming",
		});
		expect(created.success).toBe(true);
		if (!created.success) throw new Error(created.error.message);
		return created.data.item;
	}

	async function schedule(collection: string, id: string) {
		return handleContentSchedule(ctx.db, collection, id, future);
	}

	it("accepts no-scheduling in the registry and rejects scheduling without mutation", async () => {
		const registry = await createCollection("disabled", ["no-scheduling"]);
		await expect(registry.getCollection("disabled")).resolves.toMatchObject({
			supports: ["no-scheduling"],
		});
		const item = await createEntry("disabled");

		const result = await schedule("disabled", item.id);

		expect(result).toMatchObject({
			success: false,
			error: { code: "VALIDATION_ERROR", message: "Scheduling is disabled for this collection" },
		});
		const current = await new ContentRepository(ctx.db).findById("disabled", item.id);
		expect(current).toMatchObject({ id: item.id, status: "draft", scheduledAt: null });
	});

	it.each([
		["default", undefined],
		["empty supports", []],
		["drafts only", ["drafts"]],
		["legacy scheduling", ["scheduling"]],
	] as const)("allows scheduling with %s", async (_name, supports: Supports) => {
		const collection = `allowed_${_name.replace(" ", "_")}`;
		await createCollection(collection, supports);
		const item = await createEntry(collection);

		const result = await schedule(collection, item.id);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.item).toMatchObject({
				id: item.id,
				status: "scheduled",
				scheduledAt: future,
			});
		}
	});

	it("treats no-scheduling as disabling even when scheduling is also present", async () => {
		await createCollection("mixed", ["scheduling", "no-scheduling"]);
		const item = await createEntry("mixed");

		const result = await schedule("mixed", item.id);

		expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("continues publishing existing schedules after scheduling is disabled", async () => {
		const registry = await createCollection("pending", []);
		const item = await createEntry("pending");
		expect((await schedule("pending", item.id)).success).toBe(true);
		await registry.updateCollection("pending", { supports: ["no-scheduling"] });
		const repo = new ContentRepository(ctx.db);
		await repo.update("pending", item.id, { scheduledAt: "2000-01-01T00:00:00.000Z" });

		await publishDueContent(ctx.db);

		expect(await repo.findById("pending", item.id)).toMatchObject({
			status: "published",
			scheduledAt: null,
		});
	});

	it("allows unscheduling an existing item after disabling scheduling, but rejects rescheduling", async () => {
		const registry = await createCollection("changed", ["scheduling"]);
		const item = await createEntry("changed");
		expect((await schedule("changed", item.id)).success).toBe(true);

		await registry.updateCollection("changed", { supports: ["no-scheduling"] });

		const rescheduled = await handleContentSchedule(
			ctx.db,
			"changed",
			item.id,
			"2099-02-01T00:00:00.000Z",
		);
		expect(rescheduled).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		expect(await new ContentRepository(ctx.db).findById("changed", item.id)).toMatchObject({
			status: "scheduled",
			scheduledAt: future,
		});

		const unscheduled = await handleContentUnschedule(ctx.db, "changed", item.id);
		expect(unscheduled).toMatchObject({
			success: true,
			data: { item: { status: "draft", scheduledAt: null } },
		});

		const rejected = await schedule("changed", item.id);
		expect(rejected).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		const current = await new ContentRepository(ctx.db).findById("changed", item.id);
		expect(current).toMatchObject({ status: "draft", scheduledAt: null });
	});
});
