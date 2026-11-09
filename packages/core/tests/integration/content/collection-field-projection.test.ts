/**
 * `getEmDashCollection`'s `fields` option, through the same path a page render
 * takes: checks on the names before any query, reference fields, booleans, the
 * draft overlay, and a projected and a full read in one request.
 */

import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/index.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { resetTaxonomyNamesCache } from "../../../src/loader.js";
import { getEmDashCollection } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createLegacyReferenceField } from "../../utils/legacy-reference-field.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../../src/loader.js");
	const loader = emdashLoader();
	return {
		getLiveCollection: (_name: string, filter: never) => loader.loadCollection!({ filter }),
		getLiveEntry: async () => ({ entry: undefined }),
	};
});

describeEachDialect("getEmDashCollection fields", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });
		await registry.createField("authors", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "string" });
		await registry.createField("posts", { slug: "featured", label: "Featured", type: "boolean" });
		await new RelationRepository(ctx.db).create({
			slug: "post_author",
			parentCollection: "posts",
			childCollection: "authors",
			parentLabel: "Author",
			childLabel: "Posts",
		});
		await registry.createField("posts", {
			slug: "author",
			label: "Author",
			type: "reference",
			validation: { relation: "post_author", relationSide: "parent", targetCollection: "authors" },
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPost(data: Record<string, unknown>) {
		const result = await handleContentCreate(ctx.db, "posts", { data, status: "published" });
		if (!result.success) throw new Error("Failed to create entry");
		return result.data.item;
	}

	function read<T>(fn: () => Promise<T>, editMode = false): Promise<T> {
		return runWithContext({ editMode, db: ctx.db }, fn);
	}

	it("throws for an empty list, a malformed name and an unknown field", async () => {
		await createPost({ title: "One", body: "Long body" });

		await expect(read(() => getEmDashCollection("posts", { fields: [] }))).rejects.toThrow(
			"`fields` is empty",
		);
		await expect(
			read(() => getEmDashCollection("posts", { fields: ['title" FROM x --'] })),
		).rejects.toThrow("invalid name");
		await expect(read(() => getEmDashCollection("posts", { fields: ["titel"] }))).rejects.toThrow(
			'"titel" in `fields` is not a field of "posts"',
		);
	});

	it("throws for a reference field bound to a relation, naming the readers to use", async () => {
		await expect(read(() => getEmDashCollection("posts", { fields: ["author"] }))).rejects.toThrow(
			/cannot select "author".*getEmDashReferences/,
		);
	});

	it("selects a reference field that owns a column, with its stored entry id", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "editor", { targetCollection: "authors" });
		const post = await createPost({ title: "One", body: "Long body" });
		await sql`UPDATE ec_posts SET editor = ${"author-1"} WHERE id = ${post.id}`.execute(ctx.db);

		const { entries } = await read(() => getEmDashCollection("posts", { fields: ["editor"] }));

		expect(entries[0]?.data).toMatchObject({ editor: "author-1" });
		expect(entries[0]?.data).not.toHaveProperty("body");
	});

	it("accepts system field names and returns a requested boolean as a boolean", async () => {
		await createPost({ title: "One", body: "Long body", featured: true });

		const { entries } = await read(() =>
			getEmDashCollection("posts", { fields: ["slug", "featured"] }),
		);

		expect(entries[0]?.data.featured).toBe(true);
		expect(entries[0]?.data).not.toHaveProperty("title");
	});

	it("loads terms and bylines on a projected entry", async () => {
		await ctx.db
			.updateTable("_emdash_taxonomy_def_groups")
			.set({ collections: JSON.stringify(["posts"]) })
			.where("name", "=", "tag")
			.execute();
		resetTaxonomyNamesCache();
		const post = await createPost({ title: "One", body: "Long body" });
		await ctx.db
			.insertInto("taxonomies" as never)
			.values({
				id: "tag_news",
				name: "tag",
				slug: "news",
				label: "News",
				translation_group: "tag_news",
			} as never)
			.execute();
		await new TaxonomyRepository(ctx.db).attachToEntry("posts", post.id, "tag_news");
		const bylines = new BylineRepository(ctx.db);
		const author = await bylines.create({ displayName: "Ada Lovelace", slug: "ada" });
		await bylines.setContentBylines("posts", post.id, [{ bylineId: author.id, roleLabel: null }]);

		const { entries } = await read(() => getEmDashCollection("posts", { fields: ["title"] }));
		const data = entries[0]?.data as Record<string, unknown> & {
			terms?: Record<string, { slug: string }[]>;
			bylines?: { byline: { displayName: string } }[];
		};

		expect(data.terms?.tag?.map((t) => t.slug)).toEqual(["news"]);
		expect(data.bylines?.map((b) => b.byline.displayName)).toEqual(["Ada Lovelace"]);
		expect(data).not.toHaveProperty("body");
	});

	it("gives a projected and a full read of the same list in one request their own shape", async () => {
		await createPost({ title: "One", body: "Long body" });

		const { projected, full } = await read(async () => ({
			projected: await getEmDashCollection("posts", { fields: ["title"] }),
			full: await getEmDashCollection("posts"),
		}));

		expect(projected.entries[0]?.data).not.toHaveProperty("body");
		expect(full.entries[0]?.data).toMatchObject({ title: "One", body: "Long body" });
	});

	it("takes only the requested fields from a draft in edit mode", async () => {
		const post = await createPost({ title: "Live title", body: "Live body" });
		const revision = await new RevisionRepository(ctx.db).create({
			collection: "posts",
			entryId: post.id,
			data: { title: "Draft title", body: "Draft body" },
		});
		await new ContentRepository(ctx.db).setDraftRevision("posts", post.id, revision.id);

		const { entries } = await read(() => getEmDashCollection("posts", { fields: ["title"] }), true);

		expect(entries[0]?.data.title).toBe("Draft title");
		expect(entries[0]?.data).not.toHaveProperty("body");
	});
});
