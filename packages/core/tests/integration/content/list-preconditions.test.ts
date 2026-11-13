import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { POST as setTerms } from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const admin = { id: "user_admin", role: Role.ADMIN as RoleLevel };

describeEachDialect("saves based on an entry's lists", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages_ref", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages_ref", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	let entries = 0;
	async function entry(collection: string) {
		entries++;
		const created = await handleContentCreate(ctx.db, collection, {
			data: { title: `Entry ${entries}` },
			slug: `entry-${entries}`,
		});
		if (!created.success) throw new Error(created.error.message);
		return created.data.item.id;
	}

	describe("bylines", () => {
		async function bylines() {
			const repo = new BylineRepository(ctx.db);
			return Promise.all(
				["ada", "grace", "mary"].map((slug) => repo.create({ slug, displayName: slug })),
			);
		}

		async function credits(id: string) {
			const got = await runtime.handleContentGet("post", id);
			if (!got.success) throw new Error(got.error.message);
			return (got.data.item.bylines ?? []).map((credit) => credit.byline.id);
		}

		it("saves when the entry still has the credits the save was based on", async () => {
			const [ada, grace] = await bylines();
			const id = await entry("post");
			await runtime.handleContentUpdate("post", id, { bylines: [{ bylineId: ada.id }] });

			const saved = await runtime.handleContentUpdate("post", id, {
				bylines: [{ bylineId: ada.id }, { bylineId: grace.id }],
				expected: { bylines: [{ bylineId: ada.id, roleLabel: null }] },
			});

			expect(saved.success, JSON.stringify(saved)).toBe(true);
			expect(await credits(id)).toEqual([ada.id, grace.id]);
		});

		it("writes nothing when another save changed the credits since", async () => {
			const [ada, grace, mary] = await bylines();
			const id = await entry("post");
			await runtime.handleContentUpdate("post", id, { bylines: [{ bylineId: ada.id }] });
			await runtime.handleContentUpdate("post", id, {
				bylines: [{ bylineId: ada.id }, { bylineId: grace.id }],
				expected: { bylines: [{ bylineId: ada.id }] },
			});

			const refused = await runtime.handleContentUpdate("post", id, {
				bylines: [{ bylineId: ada.id }, { bylineId: mary.id }],
				expected: { bylines: [{ bylineId: ada.id }] },
			});

			expect(refused).toMatchObject({ success: false, error: { code: "LIST_CONFLICT" } });
			expect(await credits(id)).toEqual([ada.id, grace.id]);
		});

		it("lets one of two saves from the same credits through", async () => {
			const [ada, grace, mary] = await bylines();
			const id = await entry("post");
			await runtime.handleContentUpdate("post", id, { bylines: [{ bylineId: ada.id }] });
			const expected = { bylines: [{ bylineId: ada.id }] };

			const results = await Promise.all([
				runtime.handleContentUpdate("post", id, {
					bylines: [{ bylineId: ada.id }, { bylineId: grace.id }],
					expected,
				}),
				runtime.handleContentUpdate("post", id, {
					bylines: [{ bylineId: ada.id }, { bylineId: mary.id }],
					expected,
				}),
			]);

			const winners = results.flatMap((result, index) => (result.success ? [index] : []));
			expect(winners).toHaveLength(1);
			expect(results.find((result) => !result.success)).toMatchObject({
				error: { code: "LIST_CONFLICT" },
			});
			expect(await credits(id)).toEqual([ada.id, winners[0] === 0 ? grace.id : mary.id]);
		});

		it("refuses a save whose read is out of date as a list conflict", async () => {
			const [ada, grace] = await bylines();
			const id = await entry("post");
			const read = await runtime.handleContentGet("post", id);
			if (!read.success) throw new Error(read.error.message);
			await runtime.handleContentUpdate("post", id, { data: { title: "Renamed" } });

			const refused = await runtime.handleContentUpdate("post", id, {
				_rev: read.data._rev,
				bylines: [{ bylineId: ada.id }, { bylineId: grace.id }],
				expected: { bylines: [] },
			});

			expect(refused).toMatchObject({ success: false, error: { code: "LIST_CONFLICT" } });
			expect(await credits(id)).toEqual([]);
		});
	});

	describe.each([
		["staged in a draft revision", ["drafts", "revisions"] as const],
		["written as links", [] as const],
	])("a reference selection %s", (_, supports) => {
		beforeEach(async () => {
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({
				slug: "articles",
				label: "Articles",
				labelSingular: "Article",
				supports: [...supports],
			});
			await registry.createField("articles", { slug: "title", label: "Title", type: "string" });
			await new RelationRepository(ctx.db).create({
				slug: "articles_pages",
				parentCollection: "articles",
				childCollection: "pages_ref",
				parentLabel: "Articles",
				childLabel: "Pages",
			});
			await registry.createField("articles", {
				slug: "pages",
				label: "Pages",
				type: "reference",
				validation: {
					relation: "articles_pages",
					relationSide: "parent",
					targetCollection: "pages_ref",
				},
			});
		});

		async function selected(id: string) {
			const got = await runtime.handleContentGet("articles", id, undefined, {
				includeDrafts: true,
			});
			if (!got.success) throw new Error(got.error.message);
			return got.data.item.references?.pages?.children.map((child) => child.id) ?? [];
		}

		it("writes nothing when another save changed it since", async () => {
			const one = await entry("pages_ref");
			const two = await entry("pages_ref");
			const three = await entry("pages_ref");
			const id = await entry("articles");
			await runtime.handleContentUpdate("articles", id, { references: { pages: [one] } });

			const saved = await runtime.handleContentUpdate("articles", id, {
				references: { pages: [one, two] },
				expected: { references: { pages: [one] } },
			});
			const refused = await runtime.handleContentUpdate("articles", id, {
				references: { pages: [one, three] },
				expected: { references: { pages: [one] } },
			});

			expect(saved.success, JSON.stringify(saved)).toBe(true);
			expect(refused).toMatchObject({ success: false, error: { code: "LIST_CONFLICT" } });
			expect(await selected(id)).toEqual([one, two]);
		});

		it.runIf(supports.length > 0)(
			"refuses a draft change and a live one together, writing neither",
			async () => {
				const page = await entry("pages_ref");
				const repo = new BylineRepository(ctx.db);
				const credit = await repo.create({ slug: "ada", displayName: "Ada" });
				const id = await entry("articles");

				const refused = await runtime.handleContentUpdate("articles", id, {
					references: { pages: [page] },
					bylines: [{ bylineId: credit.id }],
					expected: { references: { pages: [] } },
				});

				expect(refused).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
				expect(await selected(id)).toEqual([]);
				expect(await repo.getContentBylines("articles", id)).toEqual([]);
			},
		);

		it("lets one of two saves from the same selection through", async () => {
			const one = await entry("pages_ref");
			const two = await entry("pages_ref");
			const three = await entry("pages_ref");
			const id = await entry("articles");
			await runtime.handleContentUpdate("articles", id, { references: { pages: [one] } });
			const expected = { references: { pages: [one] } };

			const results = await Promise.all([
				runtime.handleContentUpdate("articles", id, {
					references: { pages: [one, two] },
					expected,
				}),
				runtime.handleContentUpdate("articles", id, {
					references: { pages: [one, three] },
					expected,
				}),
			]);

			const winners = results.flatMap((result, index) => (result.success ? [index] : []));
			expect(winners).toHaveLength(1);
			expect(results.find((result) => !result.success)).toMatchObject({
				error: { code: "LIST_CONFLICT" },
			});
			expect(await selected(id)).toEqual([one, winners[0] === 0 ? two : three]);
		});
	});

	describe("terms", () => {
		function post(id: string, body: unknown) {
			const url = `http://localhost/_emdash/api/content/post/${id}/terms/category`;
			return setTerms({
				params: { collection: "post", id, taxonomy: "category" },
				request: new Request(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				url: new URL(url),
				locals: { emdash: handlersFromRuntime(runtime), user: admin },
				cache: { enabled: false, invalidate: vi.fn() },
			} as unknown as Parameters<typeof setTerms>[0]);
		}

		it("writes nothing when another change replaced the terms since", async () => {
			const repo = new TaxonomyRepository(ctx.db);
			const [news, tech, art] = await Promise.all(
				["news", "tech", "art"].map((slug) =>
					repo.create({ name: "category", slug, label: slug, locale: "en" }),
				),
			);
			const id = await entry("post");
			expect((await post(id, { termIds: [news.id] })).status).toBe(200);

			const saved = await post(id, { termIds: [news.id, tech.id], expected: [news.id] });
			const refused = await post(id, { termIds: [news.id, art.id], expected: [news.id] });

			expect(saved.status, await saved.clone().text()).toBe(200);
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({ error: { code: "LIST_CONFLICT" } });
			const stored = await repo.getTermsForEntry("post", id, "category");
			expect(stored.map((term) => term.id).toSorted()).toEqual([news.id, tech.id].toSorted());
		});

		it("keeps a change that lands after the check, writing only its own change", async () => {
			const repo = new TaxonomyRepository(ctx.db);
			const [news, tech, art] = await Promise.all(
				["news", "tech", "art"].map((slug) =>
					repo.create({ name: "category", slug, label: slug, locale: "en" }),
				),
			);
			const id = await entry("post");
			await repo.setTermsForEntry("post", id, "category", [news.id]);
			// Another change, landing between this change's check and its write.
			await repo.setTermsForEntry("post", id, "category", [news.id, art.id]);

			await repo.setTermsForEntry("post", id, "category", [news.id, tech.id], [news.id]);

			const stored = await repo.getTermsForEntry("post", id, "category");
			expect(stored.map((term) => term.id).toSorted()).toEqual(
				[news.id, tech.id, art.id].toSorted(),
			);
		});

		it("lets one of two changes from the same terms through, made on two translations", async () => {
			const repo = new TaxonomyRepository(ctx.db);
			const [news, tech, art] = await Promise.all(
				["news", "tech", "art"].map((slug) =>
					repo.create({ name: "category", slug, label: slug, locale: "en" }),
				),
			);
			const id = await entry("post");
			const translated = await handleContentCreate(ctx.db, "post", {
				data: { title: "Entrée" },
				slug: "entree",
				locale: "fr",
				translationOf: id,
			});
			if (!translated.success) throw new Error(translated.error.message);
			const frId = translated.data.item.id;
			expect((await post(id, { termIds: [news.id] })).status).toBe(200);

			const results = await Promise.all([
				post(id, { termIds: [news.id, tech.id], expected: [news.id] }),
				post(frId, { termIds: [news.id, art.id], expected: [news.id] }),
			]);

			expect(results.map((result) => result.status).toSorted((a, b) => a - b)).toEqual([200, 409]);
			const won = results[0]?.status === 200 ? tech.id : art.id;
			const stored = await repo.getTermsForEntry("post", id, "category");
			expect(stored.map((term) => term.id).toSorted()).toEqual([news.id, won].toSorted());
		});
	});
});
