import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentGet,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import {
	resolveReferenceSelection,
	setReferenceSelection,
	writeReferenceSelection,
} from "../../../src/api/handlers/relations.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { ContentItem } from "../../../src/database/repositories/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function referenceTranslationGroup(
	child: NonNullable<ContentItem["references"]>[string]["children"][number],
): string | null {
	return child.translationGroup;
}

describeEachDialect("reference field constraints", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function setupConstrainedFields() {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});

		const relationRepo = new RelationRepository(ctx.db);
		// Cardinality is the relation's, not the field's — a post has one featured
		// page whichever end you bind.
		const requiredSingle = await relationRepo.create({
			slug: "posts_featured_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Featured page",
			maxChildrenPerParent: 1,
		});
		const optionalMultiple = await relationRepo.create({
			slug: "posts_related_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Related pages",
		});

		await registry.createField("posts", {
			slug: "featured_page",
			label: "Featured page",
			type: "reference",
			required: true,
			validation: {
				relation: requiredSingle.slug,
				relationSide: "parent",
				targetCollection: "pages",
			},
		});
		await registry.createField("posts", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: optionalMultiple.slug,
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		return { relationRepo, requiredSingle, optionalMultiple };
	}

	async function createPage(title: string) {
		const result = await handleContentCreate(ctx.db, "pages", { data: { title } });
		if (!result.success) throw new Error("Page setup failed");
		return result.data.item;
	}

	it("rejects an ordinary create that omits a required reference", async () => {
		await setupConstrainedFields();
		const countBefore = await new ContentRepository(ctx.db).count("posts");

		const result = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("VALIDATION_ERROR");
			expect(result.error.message).toContain("featured_page");
		}
		expect(await new ContentRepository(ctx.db).count("posts")).toBe(countBefore);
	});

	it("accepts a create with one required reference while the optional field is omitted", async () => {
		await setupConstrainedFields();
		const child = await createPage("Child");

		const result = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [child.id] },
		});

		expect(result.success).toBe(true);
	});

	it("accepts required reference selections through runtime validation", async () => {
		await setupConstrainedFields();
		const child = await createPage("Child");
		const runtime = createTestRuntime(ctx.db);

		const missingStoredField = await runtime.handleContentCreate("posts", {
			data: {},
			references: { featured_page: [child.id] },
		});
		expect(missingStoredField.success).toBe(false);
		if (!missingStoredField.success) {
			expect(missingStoredField.error.message).toContain("title");
			expect(missingStoredField.error.message).not.toContain("featured_page");
		}

		const result = await runtime.handleContentCreate("posts", {
			data: { title: "Parent" },
			references: { featured_page: [child.id] },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data).toEqual({ title: "Parent" });
	});

	it("rejects multiple children on a single-reference field through content create", async () => {
		await setupConstrainedFields();
		const first = await createPage("First");
		const second = await createPage("Second");

		const result = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [first.id, second.id] },
		});

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects clearing a required reference through content update", async () => {
		await setupConstrainedFields();
		const child = await createPage("Child");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [child.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleContentUpdate(ctx.db, "posts", parent.data.item.id, {
			references: { featured_page: [] },
		});

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("allows a partial update that does not mention the required reference", async () => {
		const { relationRepo, requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [child.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleContentUpdate(ctx.db, "posts", parent.data.item.id, {
			data: { title: "Renamed" },
		});

		expect(result.success).toBe(true);
		const references = await relationRepo.getChildrenPage(
			requiredSingle.slug,
			parent.data.item.translationGroup ?? parent.data.item.id,
		);
		expect(references.items.map((item) => item.childGroup)).toEqual([child.translationGroup]);
	});

	it("rejects multiple children on a single-reference field", async () => {
		await setupConstrainedFields();
		const first = await createPage("First");
		const second = await createPage("Second");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [first.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await setReferenceSelection(
			ctx.db,
			"posts",
			parent.data.item.id,
			"featured_page",
			[first.id, second.id],
		);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("accepts one child on a single-reference field", async () => {
		const { requiredSingle, relationRepo } = await setupConstrainedFields();
		const first = await createPage("First");
		const second = await createPage("Second");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [first.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await setReferenceSelection(
			ctx.db,
			"posts",
			parent.data.item.id,
			"featured_page",
			[second.id],
		);

		expect(result.success).toBe(true);
		if (!result.success) return;
		const page = await relationRepo.getChildrenPage(requiredSingle.slug, result.data.entryGroup);
		expect(page.items.map((edge) => edge.childGroup)).toEqual([second.translationGroup]);
	});

	it("rejects clearing a required reference", async () => {
		await setupConstrainedFields();
		const child = await createPage("Child");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [child.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await setReferenceSelection(
			ctx.db,
			"posts",
			parent.data.item.id,
			"featured_page",
			[],
		);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("enforces a relation's limit rather than a per-field flag", async () => {
		// The limit is the relation's, so raising it lets an existing field hold
		// more without touching the field row.
		const { relationRepo, requiredSingle } = await setupConstrainedFields();
		const [first, second] = [await createPage("One"), await createPage("Two")];

		const rejected = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Post" },
			references: { featured_page: [first.id, second.id] },
		});
		expect(rejected.success).toBe(false);

		await relationRepo.update(requiredSingle.id, { maxChildrenPerParent: null });

		const accepted = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Post" },
			references: { featured_page: [first.id, second.id] },
		});
		expect(accepted.success, JSON.stringify(accepted)).toBe(true);
	});

	it("refuses a selection for a field the collection does not have", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		// A relation nothing views: with every write addressed by field slug, there
		// is no way to write into it and nothing to validate against.
		await new RelationRepository(ctx.db).create({
			slug: "loose_related_posts",
			parentCollection: "posts",
			childCollection: "posts",
			parentLabel: "Posts",
			childLabel: "Related posts",
		});
		const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
		const first = await handleContentCreate(ctx.db, "posts", { data: { title: "First" } });
		if (!parent.success || !first.success) throw new Error("Setup failed");

		const result = await setReferenceSelection(
			ctx.db,
			"posts",
			parent.data.item.id,
			"loose_related_posts",
			[first.data.item.id],
		);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects a selection that exceeds the other end's cardinality", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		// One page belongs to at most one post: the limit lives on the child end,
		// but only parents ever select.
		const relation = await new RelationRepository(ctx.db).create({
			slug: "posts_owned_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Post",
			childLabel: "Owned page",
			maxParentsPerChild: 1,
		});
		await registry.createField("posts", {
			slug: "owned_page",
			label: "Owned page",
			type: "reference",
			validation: {
				relation: relation.slug,
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		const page = await createPage("Shared");
		const first = await handleContentCreate(ctx.db, "posts", {
			data: { title: "First" },
			references: { owned_page: [page.id] },
		});
		expect(first.success).toBe(true);

		const second = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Second" },
			references: { owned_page: [page.id] },
		});

		expect(second.success).toBe(false);
		if (!second.success) expect(second.error.code).toBe("VALIDATION_ERROR");

		const parents = await new RelationRepository(ctx.db).getParentsPage(
			relation.slug,
			page.translationGroup ?? page.id,
		);
		expect(parents.items).toHaveLength(1);
	});

	it("refuses a selection that was claimed between resolving it and writing it", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const relation = await new RelationRepository(ctx.db).create({
			slug: "posts_owned_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Post",
			childLabel: "Owned page",
			maxParentsPerChild: 1,
		});
		await registry.createField("posts", {
			slug: "owned_page",
			label: "Owned page",
			type: "reference",
			validation: {
				relation: relation.slug,
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		const page = await createPage("Shared");
		const first = await handleContentCreate(ctx.db, "posts", { data: { title: "First" } });
		const second = await handleContentCreate(ctx.db, "posts", { data: { title: "Second" } });
		if (!first.success || !second.success) throw new Error("Setup failed");

		// Resolved while the page is still free, so the count this save read says
		// the slot is available.
		const resolved = await resolveReferenceSelection(
			ctx.db,
			"posts",
			second.data.item.id,
			"owned_page",
			[page.id],
		);
		expect(resolved.success).toBe(true);
		if (!resolved.success) return;

		// Another save takes the slot before the first one's write lands — the
		// window two concurrent requests race through.
		const claimed = await handleContentUpdate(ctx.db, "posts", first.data.item.id, {
			references: { owned_page: [page.id] },
		});
		expect(claimed.success).toBe(true);

		await expect(writeReferenceSelection(ctx.db, resolved.data)).rejects.toThrow();

		const parents = await new RelationRepository(ctx.db).getParentsPage(
			relation.slug,
			page.translationGroup ?? page.id,
		);
		expect(parents.items).toHaveLength(1);
		expect(parents.items[0]?.parentGroup).toBe(first.data.item.translationGroup);
	});

	it("inherits a source group's references when creating a translation", async () => {
		await setupConstrainedFields();
		const child = await createPage("Child");
		const source = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { featured_page: [child.id] },
		});
		if (!source.success) throw new Error("Source setup failed");

		const translation = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent in French" },
			locale: "fr",
			translationOf: source.data.item.id,
		});

		expect(translation.success).toBe(true);
		if (!translation.success) return;
		const hydrated = await handleContentGet(ctx.db, "posts", translation.data.item.id, "fr", {
			includeDrafts: true,
		});
		expect(hydrated.success).toBe(true);
		if (!hydrated.success) return;
		const selected = hydrated.data.item.references?.featured_page?.children[0];
		expect(selected?.id).toBe(child.id);
		expect(selected && referenceTranslationGroup(selected)).toBe(child.translationGroup);
	});
});
