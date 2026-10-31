import { afterEach, beforeEach, expect, it } from "vitest";

import {
	ContentRepository,
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
