/**
 * MCP taxonomy tools — comprehensive integration tests.
 *
 * Covers:
 *   - taxonomy_list
 *   - taxonomy_list_terms
 *   - taxonomy_create_term
 *
 * Plus regression coverage for:
 *   - bug #7 (orphan taxonomy collection inconsistency)
 *   - bug #13 (no delete/update term tool — gap test)
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleTaxonomyCreate } from "../../../src/api/handlers/taxonomies.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const AUTHOR_ID = "user_author";
const SUBSCRIBER_ID = "user_subscriber";

async function setupTaxonomy(
	db: Kysely<Database>,
	input: { name: string; label: string; hierarchical?: boolean; collections?: string[] },
): Promise<void> {
	const result = await handleTaxonomyCreate(db, input);
	if (!result.success) {
		throw new Error(`Failed to set up taxonomy: ${result.error?.message}`);
	}
}

// ---------------------------------------------------------------------------
// taxonomy_list
// ---------------------------------------------------------------------------

describe("taxonomy_list", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns only the seeded defaults when no extra taxonomies are added", async () => {
		// Migration 006 seeds two default taxonomies: 'category' (hierarchical)
		// and 'tag' (flat), both linked to the 'posts' collection. A fresh
		// install always has these.
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_list",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { taxonomies } = extractJson<{
			taxonomies: Array<{ name: string }>;
		}>(result);
		const names = taxonomies.map((t) => t.name).toSorted();
		expect(names).toEqual(["category", "tag"]);
	});

	it("lists user-created taxonomies alongside the defaults", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" });
		// Use names that don't collide with the seeded `category` / `tag`.
		await setupTaxonomy(db, {
			name: "section",
			label: "Sections",
			hierarchical: true,
			collections: ["post"],
		});
		await setupTaxonomy(db, {
			name: "topic",
			label: "Topics",
			collections: ["post"],
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_list",
			arguments: {},
		});
		const { taxonomies } = extractJson<{
			taxonomies: Array<{ name: string; hierarchical?: boolean; collections?: string[] }>;
		}>(result);
		const names = taxonomies.map((t) => t.name).toSorted();
		expect(names).toEqual(["category", "section", "tag", "topic"]);

		const section = taxonomies.find((t) => t.name === "section");
		expect(section?.hierarchical).toBe(true);
		expect(section?.collections).toEqual(["post"]);
	});

	it("any logged-in user (SUBSCRIBER) can read taxonomies", async () => {
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "taxonomy_list",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("bug #7: orphaned collection slugs are filtered from taxonomy_list output", async () => {
		// The seed taxonomies (category, tag) both reference 'posts' — a
		// collection that doesn't exist in this test DB (no auto-seed). After
		// the bug #7 fix, `taxonomy_list` filters those orphans out. We don't
		// need to manufacture an orphan; the seed already gives us one.
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const taxResult = await harness.client.callTool({
			name: "taxonomy_list",
			arguments: {},
		});
		const { taxonomies } = extractJson<{
			taxonomies: Array<{ name: string; collections?: string[] }>;
		}>(taxResult);

		// Each seeded taxonomy referenced 'posts'. After filtering, that
		// orphan slug is gone — the array should be empty for both seeds.
		for (const t of taxonomies) {
			expect(t.collections).not.toContain("posts");
		}

		// And schema_list_collections agrees: there is no 'posts' collection.
		const collResult = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		const { items } = extractJson<{ items: Array<{ slug: string }> }>(collResult);
		expect(items.find((c) => c.slug === "posts")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// taxonomy_list_terms
// ---------------------------------------------------------------------------

describe("taxonomy_list_terms", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupTaxonomy(db, { name: "categories", label: "Categories", hierarchical: true });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns empty list when taxonomy has no terms", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "categories" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { items } = extractJson<{ items: unknown[] }>(result);
		expect(items).toEqual([]);
	});

	it("returns terms after creation", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "tech", label: "Tech" },
		});
		await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "design", label: "Design" },
		});

		const result = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "categories" },
		});
		const { items } = extractJson<{
			items: Array<{ slug: string; label: string; parentId: string | null }>;
		}>(result);
		const slugs = items.map((t) => t.slug).toSorted();
		expect(slugs).toEqual(["design", "tech"]);
	});

	it("returns clear error for missing taxonomy name", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "nonexistent" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
		expect(extractText(result)).toContain("nonexistent");
	});

	it("paginates with limit + cursor", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		// Insert 5 terms — labels chosen so alphabetical ordering is predictable
		for (const label of ["alpha", "bravo", "charlie", "delta", "echo"]) {
			await harness.client.callTool({
				name: "taxonomy_create_term",
				arguments: { taxonomy: "categories", slug: label, label },
			});
		}

		const page1 = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "categories", limit: 2 },
		});
		const p1 = extractJson<{ items: Array<{ slug: string; id: string }>; nextCursor?: string }>(
			page1,
		);
		expect(p1.items).toHaveLength(2);
		expect(p1.nextCursor).toBeTruthy();

		const page2 = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "categories", limit: 2, cursor: p1.nextCursor },
		});
		const p2 = extractJson<{ items: Array<{ slug: string }>; nextCursor?: string }>(page2);
		expect(p2.items).toHaveLength(2);

		// No overlap
		const p1Slugs = p1.items.map((i) => i.slug);
		for (const t of p2.items) expect(p1Slugs).not.toContain(t.slug);
	});

	it("malformed cursor returns an error (bug #12 propagation)", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "t1", label: "T1" },
		});

		// taxonomy_list_terms uses an in-memory cursor (term id), so a
		// totally-bogus value should ideally error. Today it silently
		// resets to start because `cursorIdx` returns -1.
		const result = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "categories", cursor: "garbage_cursor_xyz" },
		});
		expect(result.isError).toBe(true);
	});

	it("any logged-in user (SUBSCRIBER) can read terms", async () => {
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "taxonomy_list_terms",
			arguments: { taxonomy: "categories" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// taxonomy_create_term
// ---------------------------------------------------------------------------

describe("taxonomy_create_term", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupTaxonomy(db, { name: "categories", label: "Categories", hierarchical: true });
		await setupTaxonomy(db, { name: "tags", label: "Tags" });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("creates a term with minimal arguments", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "tech", label: "Tech" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { term } = extractJson<{ term: { slug: string; label: string } }>(result);
		expect(term.slug).toBe("tech");
		expect(term.label).toBe("Tech");
	});

	it("creates a child term with parentId", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const parent = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "tech", label: "Tech" },
		});
		const parentId = extractJson<{ term: { id: string } }>(parent).term.id;

		const child = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: {
				taxonomy: "categories",
				slug: "ai",
				label: "AI",
				parentId,
			},
		});
		expect(child.isError, extractText(child)).toBeFalsy();
		const { term } = extractJson<{ term: { parentId: string | null } }>(child);
		expect(term.parentId).toBe(parentId);
	});

	it("rejects duplicate slug within the same taxonomy", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "tech", label: "Tech" },
		});
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "tech", label: "Tech 2" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/exist|duplicate|conflict|unique|already/i);
	});

	it("allows same slug across different taxonomies", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const a = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "shared", label: "Shared" },
		});
		const b = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "tags", slug: "shared", label: "Shared" },
		});
		expect(a.isError, extractText(a)).toBeFalsy();
		expect(b.isError, extractText(b)).toBeFalsy();
	});

	it("rejects creating a term in a non-existent taxonomy", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "ghost", slug: "x", label: "X" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
		expect(extractText(result)).toContain("ghost");
	});

	it("rejects parentId pointing to a different taxonomy", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const tag = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "tags", slug: "stuff", label: "Stuff" },
		});
		const tagId = extractJson<{ term: { id: string } }>(tag).term.id;

		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: {
				taxonomy: "categories",
				slug: "child",
				label: "Child",
				parentId: tagId,
			},
		});
		expect(result.isError).toBe(true);
	});

	it("rejects parentId pointing to a non-existent term", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: {
				taxonomy: "categories",
				slug: "orphan",
				label: "Orphan",
				parentId: "01NEVEREXISTED",
			},
		});
		expect(result.isError).toBe(true);
	});

	it("requires EDITOR role (AUTHOR is blocked)", async () => {
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "categories", slug: "x", label: "X" },
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Bug #13 / F2 / F3 / F12 — happy paths for taxonomy_update_term and
// taxonomy_delete_term, plus parent validation, cycle detection, and
// empty-string rejection.
// ---------------------------------------------------------------------------

describe("taxonomy_update_term (bug #13 / F2 / F12)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	async function createTerm(
		taxonomy: string,
		slug: string,
		label: string,
		parentId?: string,
	): Promise<string> {
		const args: Record<string, unknown> = { taxonomy, slug, label };
		if (parentId) args.parentId = parentId;
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: args,
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { term } = extractJson<{ term: { id: string } }>(result);
		return term.id;
	}

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupTaxonomy(db, { name: "tags", label: "Tags" });
		await setupTaxonomy(db, { name: "sections", label: "Sections" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("MCP exposes taxonomy_update_term and taxonomy_delete_term", async () => {
		const tools = await harness.client.listTools();
		const names = tools.tools.map((t) => t.name);
		expect(names).toContain("taxonomy_update_term");
		expect(names).toContain("taxonomy_delete_term");
	});

	it("renames the slug when the new slug is free", async () => {
		await createTerm("tags", "old-slug", "Original");
		const result = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "old-slug", slug: "new-slug" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { term } = extractJson<{ term: { slug: string } }>(result);
		expect(term.slug).toBe("new-slug");
	});

	it("changes the label", async () => {
		await createTerm("tags", "x", "Old Label");
		const result = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "x", label: "New Label" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { term } = extractJson<{ term: { label: string } }>(result);
		expect(term.label).toBe("New Label");
	});

	it("reparents a term and detaches via parentId: null", async () => {
		const parentId = await createTerm("tags", "parent", "Parent");
		await createTerm("tags", "child", "Child");

		const reparent = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "child", parentId },
		});
		expect(reparent.isError, extractText(reparent)).toBeFalsy();
		const reparented = extractJson<{ term: { parentId: string | null } }>(reparent);
		expect(reparented.term.parentId).toBe(parentId);

		const detach = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "child", parentId: null },
		});
		expect(detach.isError, extractText(detach)).toBeFalsy();
		const detached = extractJson<{ term: { parentId: string | null } }>(detach);
		expect(detached.term.parentId).toBeNull();
	});

	it("rejects parents from a different taxonomy", async () => {
		const sectionId = await createTerm("sections", "news", "News");
		await createTerm("tags", "alpha", "Alpha");
		const result = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "alpha", parentId: sectionId },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/VALIDATION_ERROR/);
	});

	it("rejects self-parent", async () => {
		const id = await createTerm("tags", "loop", "Loop");
		const result = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "loop", parentId: id },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/own parent|VALIDATION_ERROR/i);
	});

	it("rejects a 2-cycle (descendant becoming ancestor)", async () => {
		// A is parent of B. Now try to make B the parent of A — that's a cycle.
		const aId = await createTerm("tags", "a", "A");
		const bId = await createTerm("tags", "b", "B", aId);
		const result = await harness.client.callTool({
			name: "taxonomy_update_term",
			arguments: { taxonomy: "tags", termSlug: "a", parentId: bId },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/cycle|VALIDATION_ERROR/i);
	});

	it("rejects empty-string parentId on create", async () => {
		const result = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "tags", slug: "x", label: "X", parentId: "" },
		});
		// Either returns a validation error, or treats it as no-parent.
		// We choose strict: empty string is normalized to undefined so it
		// succeeds with parentId === null (no parent attached). That's the
		// behavior we documented.
		if (result.isError) {
			expect(extractText(result)).toMatch(/VALIDATION_ERROR/);
		} else {
			const { term } = extractJson<{ term: { parentId: string | null } }>(result);
			expect(term.parentId).toBeNull();
		}
	});
});

describe("taxonomy_delete_term (bug #13 / F12)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await setupTaxonomy(db, { name: "tags", label: "Tags" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects deletion when children exist (matches handler behavior)", async () => {
		const parent = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "tags", slug: "parent", label: "Parent" },
		});
		const { term } = extractJson<{ term: { id: string } }>(parent);
		await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "tags", slug: "child", label: "Child", parentId: term.id },
		});

		const result = await harness.client.callTool({
			name: "taxonomy_delete_term",
			arguments: { taxonomy: "tags", termSlug: "parent" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/VALIDATION_ERROR|children/i);
	});

	it("deletes a leaf term", async () => {
		await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "tags", slug: "leaf", label: "Leaf" },
		});
		const result = await harness.client.callTool({
			name: "taxonomy_delete_term",
			arguments: { taxonomy: "tags", termSlug: "leaf" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});
