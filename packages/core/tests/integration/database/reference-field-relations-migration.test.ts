import {
	sql,
	type KyselyPlugin,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	type UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { columnExists } from "../../../src/database/dialect-helpers.js";
import * as migration087 from "../../../src/database/migrations/087_reference_field_relations.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createLegacyReferenceField } from "../../utils/legacy-reference-field.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface FieldValidation {
	relation?: string;
	relationSide?: string;
	targetCollection?: string;
	multiple?: boolean;
}

/** Rows per edge INSERT that keep its six binds a row under D1's 100-parameter ceiling. */
const EDGES_PER_STATEMENT = Math.floor(100 / 6);

/**
 * Counts the statements that insert edges, and fails the one after `failAfter`
 * of them have gone through, the way a Worker cut off mid-migration would.
 */
class EdgeInsertCounter implements KyselyPlugin {
	statements = 0;

	constructor(private readonly failAfter = Number.POSITIVE_INFINITY) {}

	transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
		const text = JSON.stringify(node);
		if (text.includes("INSERT INTO") && text.includes("_emdash_content_references")) {
			if (this.statements >= this.failAfter) throw new Error("interrupted");
			this.statements += 1;
		}
		return node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

describeEachDialect("reference field relations migration (087)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "authors", label: "Authors", labelSingular: "Author" });
		await registry.createField("authors", { slug: "name", label: "Name", type: "string" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	/** Write a value straight to the legacy column, as the pre-relations writer did. */
	async function writeColumn(
		collection: string,
		entryId: string,
		column: string,
		value: string,
	): Promise<void> {
		await sql`
			UPDATE ${sql.ref(`ec_${collection}`)}
			SET ${sql.ref(column)} = ${value}
			WHERE id = ${entryId}
		`.execute(ctx.db);
	}

	async function readValidation(collection: string, field: string): Promise<FieldValidation> {
		const row = await sql<{ validation: string | null }>`
			SELECT f.validation
			FROM ${sql.ref("_emdash_fields")} AS f
			INNER JOIN ${sql.ref("_emdash_collections")} AS c ON c.id = f.collection_id
			WHERE c.slug = ${collection} AND f.slug = ${field}
		`.execute(ctx.db);
		const validation = row.rows[0]?.validation;
		return validation ? (JSON.parse(validation) as FieldValidation) : {};
	}

	function readRelations() {
		return sql<{
			id: string;
			slug: string;
			parent_collection: string;
			child_collection: string;
			parent_label: string;
			parent_label_singular: string | null;
			child_label: string;
			max_children_per_parent: number | null;
		}>`SELECT * FROM ${sql.ref("_emdash_relations")} ORDER BY slug ASC`.execute(ctx.db);
	}

	function readEdges() {
		return sql<{
			relation_id: string;
			parent_group: string;
			child_group: string;
			sort_order: number;
		}>`
			SELECT relation_id, parent_group, child_group, sort_order
			FROM ${sql.ref("_emdash_content_references")}
			ORDER BY parent_group ASC, sort_order ASC
		`.execute(ctx.db);
	}

	it("binds a field whose target is named in options.collection and copies its id in", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const author = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const post = await content.create({ type: "posts", slug: "hello", data: { title: "Hello" } });
		await writeColumn("posts", post.id, "author", author.id);

		await migration087.up(ctx.db);

		const relations = await readRelations();
		expect(relations.rows).toHaveLength(1);
		expect(relations.rows[0]).toMatchObject({
			slug: "posts_author",
			parent_collection: "posts",
			child_collection: "authors",
			parent_label: "Posts",
			parent_label_singular: "Post",
			child_label: "Author",
			// No `options.allowMultiple` means one reference, as the field helper documented.
			max_children_per_parent: 1,
		});

		expect(await readValidation("posts", "author")).toEqual({
			relation: "posts_author",
			relationSide: "parent",
			targetCollection: "authors",
			multiple: false,
		});

		const edges = await readEdges();
		expect(edges.rows).toEqual([
			{
				relation_id: relations.rows[0]!.id,
				parent_group: post.translationGroup,
				child_group: author.translationGroup,
				sort_order: 0,
			},
		]);

		// The column is the only copy of anything that did not resolve, so it stays.
		expect(await columnExists(ctx.db, "ec_posts", "author")).toBe(true);
	});

	it("copies a multiple-reference array in selection order and drops ids that no longer resolve", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "related", {
			targetCollection: "authors",
			allowMultiple: true,
		});

		const content = new ContentRepository(ctx.db);
		const first = await content.create({ type: "authors", slug: "first", data: { name: "First" } });
		const second = await content.create({
			type: "authors",
			slug: "second",
			data: { name: "Second" },
		});
		const post = await content.create({ type: "posts", slug: "hello", data: { title: "Hello" } });
		await writeColumn(
			"posts",
			post.id,
			"related",
			JSON.stringify([second.id, "gone-entry-id", first.id]),
		);

		await migration087.up(ctx.db);

		const relations = await readRelations();
		expect(relations.rows[0]?.max_children_per_parent).toBeNull();

		const edges = await readEdges();
		expect(edges.rows.map((edge) => edge.child_group)).toEqual([
			second.translationGroup,
			first.translationGroup,
		]);
		expect(edges.rows.map((edge) => edge.sort_order)).toEqual([0, 1]);
	});

	it("changes nothing on a rerun", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });
		const content = new ContentRepository(ctx.db);
		const author = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const post = await content.create({ type: "posts", slug: "hello", data: { title: "Hello" } });
		await writeColumn("posts", post.id, "author", author.id);

		await migration087.up(ctx.db);
		const relationsAfterFirst = (await readRelations()).rows;
		const edgesAfterFirst = (await readEdges()).rows;

		await migration087.up(ctx.db);

		expect((await readRelations()).rows).toEqual(relationsAfterFirst);
		expect((await readEdges()).rows).toEqual(edgesAfterFirst);
	});

	it("finishes a run that was interrupted before the field row was written", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });
		const content = new ContentRepository(ctx.db);
		const author = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const post = await content.create({ type: "posts", slug: "hello", data: { title: "Hello" } });
		await writeColumn("posts", post.id, "author", author.id);

		await migration087.up(ctx.db);
		const relationId = (await readRelations()).rows[0]!.id;

		// Roll the completion fence back: the relation and its edges landed, the
		// field row update did not.
		await sql`
			UPDATE ${sql.ref("_emdash_fields")} SET validation = NULL WHERE slug = 'author'
		`.execute(ctx.db);

		await migration087.up(ctx.db);

		const relations = await readRelations();
		expect(relations.rows).toHaveLength(1);
		expect(relations.rows[0]?.id).toBe(relationId);
		expect((await readEdges()).rows).toHaveLength(1);
		expect(await readValidation("posts", "author")).toMatchObject({ relation: "posts_author" });
	});

	/**
	 * A multiple-reference field on ten posts, each selecting thirty of forty
	 * authors in its own order: 300 edges, several statements' worth per post.
	 * Returns the edges the column describes, ordered as `readEdges` reads them.
	 */
	async function seedLargeMultipleReference() {
		await createLegacyReferenceField(ctx.db, "posts", "related", {
			targetCollection: "authors",
			allowMultiple: true,
		});
		const content = new ContentRepository(ctx.db);
		const authors = [];
		for (let index = 0; index < 40; index++) {
			authors.push(
				// oxlint-disable-next-line no-await-in-loop -- fixture setup
				await content.create({
					type: "authors",
					slug: `author-${index}`,
					data: { name: `Author ${index}` },
				}),
			);
		}

		const expected: Array<{ parent_group: string; child_group: string; sort_order: number }> = [];
		for (let postIndex = 0; postIndex < 10; postIndex++) {
			// oxlint-disable-next-line no-await-in-loop -- fixture setup
			const post = await content.create({
				type: "posts",
				slug: `post-${postIndex}`,
				data: { title: `Post ${postIndex}` },
			});
			const selected = Array.from(
				{ length: 30 },
				(_, offset) => authors[(postIndex * 7 + offset * 3) % authors.length]!,
			);
			// oxlint-disable-next-line no-await-in-loop -- fixture setup
			await writeColumn(
				"posts",
				post.id,
				"related",
				JSON.stringify(selected.map((author) => author.id)),
			);
			for (const [sortOrder, author] of selected.entries()) {
				expected.push({
					parent_group: post.translationGroup!,
					child_group: author.translationGroup!,
					sort_order: sortOrder,
				});
			}
		}
		expected.sort((a, b) =>
			a.parent_group === b.parent_group
				? a.sort_order - b.sort_order
				: a.parent_group < b.parent_group
					? -1
					: 1,
		);
		return expected;
	}

	async function readEdgeShapes() {
		return (await readEdges()).rows.map(({ parent_group, child_group, sort_order }) => ({
			parent_group,
			child_group,
			sort_order: Number(sort_order),
		}));
	}

	it("copies a large field in multi-row statements rather than one per edge", async () => {
		const expected = await seedLargeMultipleReference();
		const counter = new EdgeInsertCounter();

		await migration087.up(ctx.db.withPlugin(counter));

		expect(await readEdgeShapes()).toEqual(expected);
		expect(counter.statements).toBeGreaterThan(0);
		expect(counter.statements).toBeLessThanOrEqual(
			Math.ceil(expected.length / EDGES_PER_STATEMENT),
		);
		expect(await readValidation("posts", "related")).toMatchObject({ relation: "posts_related" });
	});

	it("resumes an edge copy that was cut off partway, sending only the missing edges", async () => {
		const expected = await seedLargeMultipleReference();

		await expect(migration087.up(ctx.db.withPlugin(new EdgeInsertCounter(4)))).rejects.toThrow(
			"interrupted",
		);
		const copiedBefore = (await readEdges()).rows.length;
		expect(copiedBefore).toBeGreaterThan(0);
		expect(copiedBefore).toBeLessThan(expected.length);
		expect(await readValidation("posts", "related")).toEqual({});

		const rerun = new EdgeInsertCounter();
		await migration087.up(ctx.db.withPlugin(rerun));

		expect(await readEdgeShapes()).toEqual(expected);
		expect(rerun.statements).toBe(
			Math.ceil((expected.length - copiedBefore) / EDGES_PER_STATEMENT),
		);
		expect(await readValidation("posts", "related")).toMatchObject({ relation: "posts_related" });
	});

	it("leaves a field alone when its slug is held by a relation of another shape", async () => {
		// The slug has no collision suffix, so that a rerun can find the relation it
		// would have created by name. A slug already in use is left alone.
		await sql`
			INSERT INTO ${sql.ref("_emdash_relations")}
				(id, slug, parent_collection, child_collection, parent_label, child_label)
			VALUES ('rel-existing', 'posts_author', 'posts', 'posts', 'Posts', 'Related')
		`.execute(ctx.db);
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		await migration087.up(ctx.db);

		expect(await readValidation("posts", "author")).toEqual({});
		expect((await readRelations()).rows).toHaveLength(1);
		expect((await readRelations()).rows[0]?.id).toBe("rel-existing");
	});

	it("leaves a field alone when its slug names a relation another field already binds", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("posts", {
			slug: "writer",
			label: "Writer",
			type: "reference",
			validation: { relation: "posts_author", relationSide: "parent", targetCollection: "authors" },
		});
		await sql`
			INSERT INTO ${sql.ref("_emdash_relations")}
				(id, slug, parent_collection, child_collection, parent_label, child_label,
				 max_children_per_parent)
			VALUES ('rel-writer', 'posts_author', 'posts', 'authors', 'Posts', 'Writer', 1)
		`.execute(ctx.db);
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		await migration087.up(ctx.db);

		// Two fields over one relation and side have no defined merge, so the
		// unbound field stays unbound even though the relation's shape matches.
		expect(await readValidation("posts", "author")).toEqual({});
	});

	it("leaves the second of two fields whose relation slugs truncate alike unbound", async () => {
		// `{collection}_{field}` is cut to 63 chars, so two long field slugs on one
		// collection can name the same relation. Merging their selections into one
		// edge set would make each field show the other's entries.
		//
		// The slugs diverge past `posts_`'s 57 characters of room but within the 63
		// Postgres allows an identifier, so they collide as relation slugs while
		// staying two distinct columns.
		const first = `author_${"x".repeat(50)}${"a".repeat(6)}`;
		const second = `author_${"x".repeat(50)}${"b".repeat(6)}`;
		await createLegacyReferenceField(ctx.db, "posts", first, { targetCollection: "authors" });
		await createLegacyReferenceField(ctx.db, "posts", second, { targetCollection: "authors" });

		await migration087.up(ctx.db);

		const firstValidation = await readValidation("posts", first);
		const secondValidation = await readValidation("posts", second);
		expect(firstValidation.relation).toBe(`posts_${first}`.slice(0, 63));
		expect(secondValidation).toEqual({});
	});

	it("accepts a target named in validation.targetCollection", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", {
			validationTargetCollection: "authors",
		});

		await migration087.up(ctx.db);

		expect(await readValidation("posts", "author")).toMatchObject({
			relation: "posts_author",
			targetCollection: "authors",
		});
	});

	it("leaves a field alone when no target collection can be resolved", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", {});
		await createLegacyReferenceField(ctx.db, "posts", "editor", { targetCollection: "gone" });

		await migration087.up(ctx.db);

		expect((await readRelations()).rows).toEqual([]);
		expect(await readValidation("posts", "author")).toEqual({});
		expect(await readValidation("posts", "editor")).toEqual({});
	});

	it("leaves an indexed or searchable field alone, so its column keeps serving queries", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", {
			targetCollection: "authors",
			indexed: true,
		});
		await createLegacyReferenceField(ctx.db, "posts", "editor", {
			targetCollection: "authors",
			searchable: true,
		});

		await migration087.up(ctx.db);

		expect((await readRelations()).rows).toEqual([]);
		expect(await readValidation("posts", "author")).toEqual({});
		expect(await readValidation("posts", "editor")).toEqual({});
	});

	it("leaves a single-reference field unbound when its locale rows disagree", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const jane = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const rosa = await content.create({ type: "authors", slug: "rosa", data: { name: "Rosa" } });
		const english = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello" },
		});
		const french = await content.create({
			type: "posts",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: english.id,
		});
		await writeColumn("posts", english.id, "author", jane.id);
		await writeColumn("posts", french.id, "author", rosa.id);

		await migration087.up(ctx.db);

		// A link is shared across an entry's translations, so there is no answer
		// here that keeps both choices. Binding would have to discard one, so the
		// field stays as it was and an editor decides.
		expect(await readValidation("posts", "author")).toEqual({});
		expect((await readRelations()).rows).toHaveLength(0);
		expect((await readEdges()).rows).toHaveLength(0);
		// Both values are still readable in the column.
		const values = await sql<{ author: string | null }>`
			SELECT author FROM ${sql.ref("ec_posts")} ORDER BY locale ASC
		`.execute(ctx.db);
		expect(values.rows.map((row) => row.author)).toEqual([jane.id, rosa.id]);
	});

	it("leaves a multiple-reference field unbound when its locale rows disagree", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", {
			targetCollection: "authors",
			allowMultiple: true,
		});

		const content = new ContentRepository(ctx.db);
		const jane = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const rosa = await content.create({ type: "authors", slug: "rosa", data: { name: "Rosa" } });
		const english = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello" },
		});
		const french = await content.create({
			type: "posts",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: english.id,
		});
		await writeColumn("posts", english.id, "author", JSON.stringify([jane.id]));
		await writeColumn("posts", french.id, "author", JSON.stringify([rosa.id]));

		await migration087.up(ctx.db);

		// The union would hand each locale the other's entry, which is a different
		// selection from the one either of them had.
		expect(await readValidation("posts", "author")).toEqual({});
		expect((await readEdges()).rows).toHaveLength(0);
	});

	it("binds a field whose locale rows agree", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const jane = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const english = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello" },
		});
		const french = await content.create({
			type: "posts",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: english.id,
		});
		// The same choice in both locales.
		await writeColumn("posts", english.id, "author", jane.id);
		await writeColumn("posts", french.id, "author", jane.id);

		await migration087.up(ctx.db);

		expect(await readValidation("posts", "author")).toMatchObject({ relation: "posts_author" });
		const edges = await readEdges();
		expect(edges.rows).toHaveLength(1);
		expect(edges.rows[0]?.child_group).toBe(jane.translationGroup);
	});

	it("binds a field whose locale rows point at translations of one entry", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const jane = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const jeanne = await content.create({
			type: "authors",
			slug: "jeanne",
			data: { name: "Jeanne" },
			locale: "fr",
			translationOf: jane.id,
		});
		const english = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello" },
		});
		const french = await content.create({
			type: "posts",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: english.id,
		});
		// Each locale names its own row of one author — the same selection said
		// twice, not two selections, because an edge names a translation group.
		await writeColumn("posts", english.id, "author", jane.id);
		await writeColumn("posts", french.id, "author", jeanne.id);

		await migration087.up(ctx.db);

		expect(await readValidation("posts", "author")).toMatchObject({ relation: "posts_author" });
		const edges = await readEdges();
		expect(edges.rows).toHaveLength(1);
		expect(edges.rows[0]?.child_group).toBe(jane.translationGroup);
	});

	it("binds a field one locale left empty and another selected", async () => {
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });

		const content = new ContentRepository(ctx.db);
		const jane = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const english = await content.create({
			type: "posts",
			slug: "hello",
			data: { title: "Hello" },
		});
		await content.create({
			type: "posts",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: english.id,
		});
		// Only the English row chose. A row that chose nothing contradicts
		// nothing, so the group's one answer carries across its translations.
		await writeColumn("posts", english.id, "author", jane.id);

		await migration087.up(ctx.db);

		expect(await readValidation("posts", "author")).toMatchObject({ relation: "posts_author" });
		const edges = await readEdges();
		expect(edges.rows).toHaveLength(1);
		expect(edges.rows[0]?.child_group).toBe(jane.translationGroup);
	});

	it("leaves a field alone when its slug names a relation it did not create", async () => {
		// Same ends and the same limit a binding would have asked for, but made by
		// hand: the migration has no claim on it, and adding this field's edges to
		// it would change a relation someone else is using.
		await sql`
			INSERT INTO ${sql.ref("_emdash_relations")}
				(id, slug, parent_collection, child_collection, parent_label, child_label,
				 max_children_per_parent)
			VALUES ('rel-by-hand', 'posts_author', 'posts', 'authors', 'Posts', 'Author', 1)
		`.execute(ctx.db);
		await createLegacyReferenceField(ctx.db, "posts", "author", { targetCollection: "authors" });
		const content = new ContentRepository(ctx.db);
		const author = await content.create({ type: "authors", slug: "jane", data: { name: "Jane" } });
		const post = await content.create({ type: "posts", slug: "hello", data: { title: "Hello" } });
		await writeColumn("posts", post.id, "author", author.id);

		await migration087.up(ctx.db);

		expect(await readValidation("posts", "author")).toEqual({});
		expect((await readRelations()).rows).toHaveLength(1);
		expect((await readEdges()).rows).toHaveLength(0);
	});
});
