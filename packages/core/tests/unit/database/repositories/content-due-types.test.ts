import { afterEach, beforeEach, expect, it } from "vitest";

import {
	ContentRepository,
	findNextScheduledAt,
	findTypesWithDueContent,
} from "../../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { SQL_BATCH_SIZE } from "../../../../src/utils/chunks.js";
import { createPageFixture, createPostFixture } from "../../../utils/fixtures.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";

describeEachDialect("findTypesWithDueContent()", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("returns only the collections with due, live entries", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		const due = await repo.create(createPageFixture({ slug: "due" }));
		await repo.update("page", due.id, { status: "scheduled", scheduledAt: past });
		const post = await repo.create(createPostFixture());
		await repo.schedule("post", post.id, new Date(Date.now() + 86_400_000).toISOString());

		expect(await findTypesWithDueContent(ctx.db, ["post", "page"], new Date())).toEqual(
			new Set(["page"]),
		);

		await repo.delete("page", due.id);

		expect(await findTypesWithDueContent(ctx.db, ["post", "page"], new Date())).toEqual(new Set());
	});

	it("checks more collections than fit in one statement", async () => {
		const registry = new SchemaRegistry(ctx.db);
		const types: string[] = [];
		for (let index = 0; index < SQL_BATCH_SIZE + 2; index++) {
			const slug = `due_${index}`;
			await registry.createCollection({ slug, label: slug, labelSingular: slug });
			types.push(slug);
		}
		const dueTypes = [types[1]!, types[SQL_BATCH_SIZE + 1]!];
		const past = new Date(Date.now() - 60_000).toISOString();
		for (const type of dueTypes) {
			const item = await repo.create({ type, slug: "due", data: {} });
			await repo.update(type, item.id, { status: "scheduled", scheduledAt: past });
		}

		expect(await findTypesWithDueContent(ctx.db, types, new Date())).toEqual(new Set(dueTypes));
	});
});

describeEachDialect("findNextScheduledAt()", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("returns the earliest live entry scheduled after `after` and by `until`", async () => {
		const start = Date.now();
		const at = (offsetMs: number) => new Date(start + offsetMs).toISOString();
		const schedule = async (type: "post" | "page", slug: string, scheduledAt: string) => {
			const fixture = type === "post" ? createPostFixture({ slug }) : createPageFixture({ slug });
			const item = await repo.create(fixture);
			await repo.update(type, item.id, { status: "scheduled", scheduledAt });
			return item;
		};
		await schedule("post", "due", at(-1_000));
		const deleted = await schedule("page", "deleted", at(10_000));
		await repo.delete("page", deleted.id);
		await schedule("post", "later", at(40_000));
		await schedule("page", "next", at(30_000));
		await schedule("page", "outside", at(5 * 60_000));

		const until = new Date(start + 2 * 60_000);
		expect(await findNextScheduledAt(ctx.db, ["post", "page"], new Date(start), until)).toEqual(
			new Date(at(30_000)),
		);
		expect(
			await findNextScheduledAt(ctx.db, ["post", "page"], new Date(at(30_000)), until),
		).toEqual(new Date(at(40_000)));
		expect(
			await findNextScheduledAt(ctx.db, ["post", "page"], new Date(at(40_000)), until),
		).toBeNull();
	});
});
