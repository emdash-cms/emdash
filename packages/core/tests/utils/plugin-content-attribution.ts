import { type Kysely, sql } from "kysely";
import { expect, it } from "vitest";

import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { UserRepository } from "../../src/database/repositories/user.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

export const ATTRIBUTION_COLLECTION = "attribution_posts";

interface PluginContentItem {
	id: string;
	data: Record<string, unknown>;
}

export interface ContentAttributionAccess {
	create(data: Record<string, unknown>): Promise<PluginContentItem>;
	update(id: string, data: Record<string, unknown>): Promise<PluginContentItem>;
	get(id: string): Promise<PluginContentItem | null>;
	list(): Promise<{ items: PluginContentItem[] }>;
	createMany?(items: Array<Record<string, unknown>>): Promise<PluginContentItem[]>;
}

export async function seedContentAttribution(db: Kysely<Database>) {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: ATTRIBUTION_COLLECTION,
		label: "Posts",
		supports: ["drafts", "revisions"],
	});
	await registry.createField(ATTRIBUTION_COLLECTION, {
		slug: "title",
		label: "Title",
		type: "string",
	});

	const users = new UserRepository(db);
	const originalAuthor = await users.create({ email: "author@example.com", role: "author" });
	const otherAuthor = await users.create({ email: "other@example.com", role: "author" });
	const bylines = new BylineRepository(db);
	const originalByline = await bylines.create({
		slug: "original-author",
		displayName: "Original author",
		userId: originalAuthor.id,
	});
	const otherByline = await bylines.create({
		slug: "other-author",
		displayName: "Other author",
		userId: otherAuthor.id,
	});
	const original = await new ContentRepository(db).create({
		type: ATTRIBUTION_COLLECTION,
		slug: "original-post",
		status: "published",
		authorId: originalAuthor.id,
		locale: "en",
		data: { title: "Original title" },
	});
	await bylines.setContentBylines(ATTRIBUTION_COLLECTION, original.id, [
		{ bylineId: originalByline.id },
	]);

	return {
		db,
		originalId: original.id,
		originalAuthorId: originalAuthor.id,
		originalBylineId: originalByline.translationGroup ?? originalByline.id,
		otherAuthorId: otherAuthor.id,
		otherBylineId: otherByline.translationGroup ?? otherByline.id,
	};
}

export type ContentAttributionFixture = Awaited<ReturnType<typeof seedContentAttribution>>;

interface StoredContent {
	author_id: string | null;
	primary_byline_id: string | null;
	title: string;
	draft_revision_id: string | null;
}

async function storedContent(db: Kysely<Database>, id: string): Promise<StoredContent> {
	const { rows } = await sql<StoredContent>`
		SELECT author_id, primary_byline_id, title, draft_revision_id
		FROM ${sql.ref(`ec_${ATTRIBUTION_COLLECTION}`)} WHERE id = ${id}
	`.execute(db);
	const row = rows[0];
	if (!row) throw new Error(`Missing content row: ${id}`);
	return row;
}

export function registerContentAttributionTests(
	getContext: () => { fixture: ContentAttributionFixture; access: ContentAttributionAccess },
	includeBatchCreate = false,
): void {
	it.each(["author_id", "primary_byline_id"] as const)(
		"ignores an existing %s supplied in plugin creation data",
		async (column) => {
			const { fixture, access } = getContext();
			const suppliedId = column === "author_id" ? fixture.otherAuthorId : fixture.otherBylineId;
			const created = await access.create({ title: "Plugin title", [column]: suppliedId });

			expect(await storedContent(fixture.db, created.id)).toMatchObject({
				author_id: null,
				primary_byline_id: null,
				title: "Plugin title",
			});
			expect(created.data).toEqual({ title: "Plugin title" });
			expect((await access.get(created.id))?.data).toEqual({ title: "Plugin title" });
			const listed = (await access.list()).items.find((item) => item.id === created.id);
			expect(listed?.data).toEqual({ title: "Plugin title" });
		},
	);

	it.each(["get", "list"] as const)(
		"keeps host attribution out of content/%s data",
		async (method) => {
			const { fixture, access } = getContext();
			const item =
				method === "get"
					? await access.get(fixture.originalId)
					: (await access.list()).items.find((entry) => entry.id === fixture.originalId);

			expect(item?.data).toEqual({ title: "Original title" });
		},
	);

	it("preserves host attribution when a plugin stages and the host publishes an edit", async () => {
		const { fixture, access } = getContext();
		const updated = await access.update(fixture.originalId, {
			title: "Revised title",
			author_id: fixture.otherAuthorId,
			primary_byline_id: fixture.otherBylineId,
		});

		expect(updated.data).toEqual({ title: "Revised title" });
		const stored = await storedContent(fixture.db, fixture.originalId);
		expect(stored).toMatchObject({
			author_id: fixture.originalAuthorId,
			primary_byline_id: fixture.originalBylineId,
			title: "Original title",
			draft_revision_id: expect.any(String),
		});
		if (!stored.draft_revision_id) throw new Error("The plugin edit did not create a draft");
		const revision = await new RevisionRepository(fixture.db).findById(stored.draft_revision_id);
		expect(revision?.data).toEqual({ title: "Revised title" });

		const published = await new ContentRepository(fixture.db).publish(
			ATTRIBUTION_COLLECTION,
			fixture.originalId,
		);
		expect(published).toMatchObject({
			authorId: fixture.originalAuthorId,
			primaryBylineId: fixture.originalBylineId,
			data: { title: "Revised title" },
		});
		const credits = await fixture.db
			.selectFrom("_emdash_content_bylines")
			.select("byline_id")
			.where("collection_slug", "=", ATTRIBUTION_COLLECTION)
			.where("content_id", "=", fixture.originalId)
			.execute();
		expect(credits).toEqual([{ byline_id: fixture.originalBylineId }]);
	});

	if (includeBatchCreate) {
		it("ignores attribution references in every item of a plugin batch create", async () => {
			const { fixture, access } = getContext();
			if (!access.createMany) throw new Error("Batch creation is unavailable");
			const created = await access.createMany([
				{
					title: "First post",
					author_id: fixture.originalAuthorId,
					primary_byline_id: fixture.originalBylineId,
				},
				{
					title: "Second post",
					author_id: fixture.otherAuthorId,
					primary_byline_id: fixture.otherBylineId,
				},
			]);

			expect(created).toHaveLength(2);
			for (const item of created) {
				expect(await storedContent(fixture.db, item.id)).toMatchObject({
					author_id: null,
					primary_byline_id: null,
					title: item.data.title,
				});
				expect((await access.get(item.id))?.data).toEqual({ title: item.data.title });
			}
		});
	}
}
