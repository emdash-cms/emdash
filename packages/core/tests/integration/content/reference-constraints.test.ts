import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentGet,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { handleReferenceChildrenSet } from "../../../src/api/handlers/relations.js";
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
		const requiredSingle = await relationRepo.create({
			name: "posts_featured_page",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Featured page",
		});
		const optionalMultiple = await relationRepo.create({
			name: "posts_related_pages",
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
				relation: requiredSingle.translationGroup,
				targetCollection: "pages",
				multiple: false,
			},
		});
		await registry.createField("posts", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: optionalMultiple.translationGroup,
				targetCollection: "pages",
				multiple: true,
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
		const { requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");

		const result = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [child.id] },
		});

		expect(result.success).toBe(true);
	});

	it("accepts required reference selections through runtime validation", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");
		const runtime = createTestRuntime(ctx.db);

		const missingStoredField = await runtime.handleContentCreate("posts", {
			data: {},
			references: { [requiredSingle.translationGroup]: [child.id] },
		});
		expect(missingStoredField.success).toBe(false);
		if (!missingStoredField.success) {
			expect(missingStoredField.error.message).toContain("title");
			expect(missingStoredField.error.message).not.toContain("featured_page");
		}

		const result = await runtime.handleContentCreate("posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [child.id] },
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.item.data).toEqual({ title: "Parent" });
	});

	it("rejects multiple children on a single-reference field through content create", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const first = await createPage("First");
		const second = await createPage("Second");

		const result = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [first.id, second.id] },
		});

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects clearing a required reference through content update", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [child.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleContentUpdate(ctx.db, "posts", parent.data.item.id, {
			references: { [requiredSingle.translationGroup]: [] },
		});

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("allows a partial update that does not mention the required reference", async () => {
		const { relationRepo, requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [child.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleContentUpdate(ctx.db, "posts", parent.data.item.id, {
			data: { title: "Renamed" },
		});

		expect(result.success).toBe(true);
		const references = await relationRepo.getChildrenPage(
			requiredSingle.translationGroup,
			parent.data.item.translationGroup ?? parent.data.item.id,
		);
		expect(references.items.map((item) => item.childGroup)).toEqual([child.translationGroup]);
	});

	it("rejects multiple children on a single-reference field through the edge endpoint", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const first = await createPage("First");
		const second = await createPage("Second");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [first.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleReferenceChildrenSet(
			ctx.db,
			"posts",
			parent.data.item.id,
			requiredSingle.translationGroup,
			[first.id, second.id],
		);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("accepts one child on a single-reference field through the edge endpoint", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const first = await createPage("First");
		const second = await createPage("Second");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [first.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleReferenceChildrenSet(
			ctx.db,
			"posts",
			parent.data.item.id,
			requiredSingle.translationGroup,
			[second.id],
		);

		expect(result.success).toBe(true);
		if (result.success) expect(result.data.children.map((child) => child.id)).toEqual([second.id]);
	});

	it("rejects clearing a required reference through the edge endpoint", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");
		const parent = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [child.id] },
		});
		if (!parent.success) throw new Error("Parent setup failed");

		const result = await handleReferenceChildrenSet(
			ctx.db,
			"posts",
			parent.data.item.id,
			requiredSingle.translationGroup,
			[],
		);

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("leaves a relation without a backing reference field unconstrained", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		const relation = await new RelationRepository(ctx.db).create({
			name: "loose_related_posts",
			parentCollection: "posts",
			childCollection: "posts",
			parentLabel: "Posts",
			childLabel: "Related posts",
		});
		const parent = await handleContentCreate(ctx.db, "posts", { data: { title: "Parent" } });
		const first = await handleContentCreate(ctx.db, "posts", { data: { title: "First" } });
		const second = await handleContentCreate(ctx.db, "posts", { data: { title: "Second" } });
		if (!parent.success || !first.success || !second.success) throw new Error("Setup failed");

		const result = await handleReferenceChildrenSet(
			ctx.db,
			"posts",
			parent.data.item.id,
			relation.translationGroup,
			[first.data.item.id, second.data.item.id],
		);

		expect(result.success).toBe(true);
	});

	it("inherits a source group's references when creating a translation", async () => {
		const { requiredSingle } = await setupConstrainedFields();
		const child = await createPage("Child");
		const source = await handleContentCreate(ctx.db, "posts", {
			data: { title: "Parent" },
			references: { [requiredSingle.translationGroup]: [child.id] },
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
		const selected = hydrated.data.item.references?.[requiredSingle.translationGroup]?.children[0];
		expect(selected?.id).toBe(child.id);
		expect(selected && referenceTranslationGroup(selected)).toBe(child.translationGroup);
	});
});
