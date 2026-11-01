/**
 * SEO, byline credits and taxonomy terms follow a published entry's draft the
 * way its fields and slug do: staged on save, written to their tables on every
 * publish path, dropped with a discarded draft and brought back by a restore.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	GET as getEntryTerms,
	POST as postEntryTerms,
} from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { publishDueContent } from "../../../src/scheduled-publish.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function ok<T>(result: { success: boolean; data?: T; error?: { message: string } }): T {
	if (!result.success || result.data === undefined) {
		throw new Error(`Expected success, got: ${result.error?.message ?? "no data"}`);
	}
	return result.data;
}

describeEachDialect("staged SEO, bylines and terms", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let alice: string;
	let bob: string;
	/** Each term's translation group, by slug: what a draft stages. */
	let group: Record<string, string>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			hasSeo: true,
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });

		const bylines = new BylineRepository(ctx.db);
		alice = (await bylines.create({ slug: "alice", displayName: "Alice" })).id;
		bob = (await bylines.create({ slug: "bob", displayName: "Bob" })).id;

		const terms = new TaxonomyRepository(ctx.db);
		group = {};
		for (const [name, slug] of [
			["category", "news"],
			["category", "guides"],
			["tag", "ai"],
			["tag", "seo"],
		] as const) {
			const term = await terms.create({ name, slug, label: slug, locale: "en" });
			group[slug] = term.translationGroup ?? term.id;
		}

		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPublished(title: string) {
		const created = ok(
			await runtime.handleContentCreate("post", {
				data: { title },
				slug: title.toLowerCase(),
				seo: { title: "Live title", description: "Live description" },
				bylines: [{ bylineId: alice }],
				taxonomies: { category: ["news"], tag: ["ai"] },
			}),
		);
		ok(await runtime.handleContentPublish("post", created.item.id));
		return created.item.id;
	}

	async function liveSeo(id: string) {
		return new SeoRepository(ctx.db).get("post", id);
	}

	async function liveBylineSlugs(id: string) {
		const credits = await new BylineRepository(ctx.db).getContentBylines("post", id);
		return credits.map((credit) => credit.byline.slug);
	}

	async function liveTermSlugs(id: string, taxonomy: string) {
		const terms = await new TaxonomyRepository(ctx.db).getTermsForEntry("post", id, taxonomy);
		return terms.map((term) => term.slug).toSorted();
	}

	async function draftData(id: string) {
		const entry = await new ContentRepository(ctx.db).findById("post", id);
		if (!entry?.draftRevisionId) return undefined;
		return (await new RevisionRepository(ctx.db).findById(entry.draftRevisionId))?.data;
	}

	async function stageAll(id: string) {
		return runtime.handleContentUpdate("post", id, {
			seo: { title: "Staged title" },
			bylines: [{ bylineId: bob, roleLabel: "Editor" }],
			taxonomies: { category: ["guides"] },
		});
	}

	async function expectLiveUnchanged(id: string) {
		expect((await liveSeo(id)).title).toBe("Live title");
		expect(await liveBylineSlugs(id)).toEqual(["alice"]);
		expect(await liveTermSlugs(id, "category")).toEqual(["news"]);
	}

	async function expectStagedLive(id: string) {
		const seo = await liveSeo(id);
		expect(seo.title).toBe("Staged title");
		expect(seo.description).toBe("Live description");
		expect(await liveBylineSlugs(id)).toEqual(["bob"]);
		expect(await liveTermSlugs(id, "category")).toEqual(["guides"]);
		expect(await liveTermSlugs(id, "tag")).toEqual(["ai"]);
	}

	describe("saving a published entry", () => {
		it("stages them in the draft instead of writing their tables", async () => {
			const id = await createPublished("Staged");

			const saved = await stageAll(id);
			expect(saved.success).toBe(true);
			expect(saved.liveContentChanged).toBe(false);

			await expectLiveUnchanged(id);
			const draft = await draftData(id);
			expect(draft?._seo).toEqual({ title: "Staged title" });
			expect(draft?._bylines).toEqual([{ bylineId: bob, roleLabel: "Editor" }]);
			expect(draft?._terms).toEqual({ category: [group.guides] });
		});

		it("returns the staged values to a draft reader and the live ones otherwise", async () => {
			const id = await createPublished("Read");
			const saved = ok(await stageAll(id));
			expect(saved.item.seo?.title).toBe("Staged title");
			expect(saved.item.bylines?.map((credit) => credit.byline.slug)).toEqual(["bob"]);

			const editor = ok(
				await runtime.handleContentGet("post", id, undefined, undefined, {
					includeStagedMetadata: true,
				}),
			);
			expect(editor.item.seo).toMatchObject({
				title: "Staged title",
				description: "Live description",
			});
			expect(editor.item.bylines?.map((credit) => [credit.byline.slug, credit.roleLabel])).toEqual([
				["bob", "Editor"],
			]);
			expect(editor.item.byline?.slug).toBe("bob");
			expect(editor.item.primaryBylineId).toBe(bob);
			expect(editor.item.data).not.toHaveProperty("_seo");
			expect(editor.item.data).not.toHaveProperty("_bylines");
			expect(editor.item.data).not.toHaveProperty("_terms");

			const reader = ok(await runtime.handleContentGet("post", id));
			expect(reader.item.seo?.title).toBe("Live title");
			expect(reader.item.bylines?.map((credit) => credit.byline.slug)).toEqual(["alice"]);
		});

		it("merges a later partial save into what the draft already stages", async () => {
			const id = await createPublished("Merge");
			ok(await stageAll(id));
			ok(
				await runtime.handleContentUpdate("post", id, {
					seo: { description: "Staged description" },
					taxonomies: { tag: ["seo"] },
				}),
			);
			ok(await runtime.handleContentUpdate("post", id, { data: { title: "Merge, again" } }));

			const draft = await draftData(id);
			expect(draft?._seo).toEqual({ title: "Staged title", description: "Staged description" });
			expect(draft?._bylines).toEqual([{ bylineId: bob, roleLabel: "Editor" }]);
			expect(draft?._terms).toEqual({ category: [group.guides], tag: [group.seo] });
		});

		it("refuses a term or byline its table write would refuse, staging nothing", async () => {
			const id = await createPublished("Refused");

			const badTerm = await runtime.handleContentUpdate("post", id, {
				taxonomies: { category: ["missing"] },
			});
			expect(badTerm.success).toBe(false);
			expect(badTerm.error?.code).toBe("VALIDATION_ERROR");

			const badByline = await runtime.handleContentUpdate("post", id, {
				bylines: [{ bylineId: "no-such-byline" }],
			});
			expect(badByline.success).toBe(false);
			expect(badByline.error?.code).toBe("VALIDATION_ERROR");

			expect(await draftData(id)).toBeUndefined();
			await expectLiveUnchanged(id);
		});
	});

	it("writes them directly on an entry that was never published", async () => {
		const created = ok(
			await runtime.handleContentCreate("post", { data: { title: "Draft" }, slug: "draft" }),
		);
		const id = created.item.id;

		ok(
			await runtime.handleContentUpdate("post", id, {
				seo: { title: "Direct" },
				bylines: [{ bylineId: bob }],
				taxonomies: { category: ["guides"] },
			}),
		);

		expect((await liveSeo(id)).title).toBe("Direct");
		expect(await liveBylineSlugs(id)).toEqual(["bob"]);
		expect(await liveTermSlugs(id, "category")).toEqual(["guides"]);
		const draft = await draftData(id);
		expect(draft?._seo).toBeUndefined();
		expect(draft?._bylines).toBeUndefined();
		expect(draft?._terms).toBeUndefined();
	});

	it("applies them when the draft is published", async () => {
		const id = await createPublished("Publish");
		ok(await stageAll(id));

		ok(await runtime.handleContentPublish("post", id));

		await expectStagedLive(id);
		const entry = await new ContentRepository(ctx.db).findById("post", id);
		expect(entry?.draftRevisionId).toBeNull();
	});

	it("applies them when the scheduled publish runs", async () => {
		const id = await createPublished("Scheduled");
		ok(await stageAll(id));
		const future = new Date(Date.now() + 86_400_000).toISOString();
		ok(await runtime.handleContentSchedule("post", id, future));
		await expectLiveUnchanged(id);

		const published = await publishDueContent(ctx.db, {
			currentTime: new Date(Date.now() + 2 * 86_400_000),
		});

		expect(published).toEqual([{ collection: "post", id }]);
		await expectStagedLive(id);
	});

	it("refuses a publish whose staged term no longer exists, leaving the draft", async () => {
		const id = await createPublished("Stale");
		ok(await stageAll(id));
		const guides = await new TaxonomyRepository(ctx.db).findBySlug("category", "guides", "en");
		await new TaxonomyRepository(ctx.db).delete(guides!.id);

		const result = await runtime.handleContentPublish("post", id);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("VALIDATION_ERROR");
		expect((await liveSeo(id)).title).toBe("Live title");
		expect(await liveBylineSlugs(id)).toEqual(["alice"]);
		expect((await draftData(id))?._seo).toEqual({ title: "Staged title" });
	});

	it("drops them with a discarded draft", async () => {
		const id = await createPublished("Discard");
		ok(await stageAll(id));

		ok(await runtime.handleContentDiscardDraft("post", id));
		ok(await runtime.handleContentPublish("post", id));

		await expectLiveUnchanged(id);
	});

	it("brings them back when the revision that staged them is restored", async () => {
		const id = await createPublished("Restore");
		ok(await stageAll(id));
		const stagedRevisionId = (await new ContentRepository(ctx.db).findById("post", id))
			?.draftRevisionId;
		ok(await runtime.handleContentDiscardDraft("post", id));

		ok(await runtime.handleRevisionRestore(stagedRevisionId!, "user-1"));
		await expectLiveUnchanged(id);
		expect((await draftData(id))?._terms).toEqual({ category: [group.guides] });

		ok(await runtime.handleContentPublish("post", id));
		await expectStagedLive(id);
	});

	it("keeps staging a part on an unpublished entry whose draft already stages it", async () => {
		const id = await createPublished("Unpublished");
		ok(await stageAll(id));
		ok(await runtime.handleContentUnpublish("post", id));

		ok(await runtime.handleContentUpdate("post", id, { seo: { description: "Later" } }));

		expect((await liveSeo(id)).description).toBe("Live description");
		expect((await draftData(id))?._seo).toEqual({
			title: "Staged title",
			description: "Later",
		});
	});

	describe("the content-terms route", () => {
		const editor = { id: "u-editor", email: "e@example.com", name: "Editor", role: Role.ADMIN };
		const subscriber = {
			id: "u-reader",
			email: "r@example.com",
			name: "Reader",
			role: Role.SUBSCRIBER,
		};

		function routeContext(
			id: string,
			taxonomy: string,
			user: { id: string; role: RoleLevel },
			termIds?: string[],
		): APIContext {
			const url = new URL(`http://localhost/_emdash/api/content/post/${id}/terms/${taxonomy}`);
			return {
				params: { collection: "post", id, taxonomy },
				url,
				request: new Request(url, {
					method: termIds ? "POST" : "GET",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					body: termIds ? JSON.stringify({ termIds }) : undefined,
				}),
				locals: {
					emdash: {
						db: ctx.db,
						handleContentGet: runtime.handleContentGet.bind(runtime),
						handleContentUpdate: runtime.handleContentUpdate.bind(runtime),
					},
					user,
				},
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
			} as unknown as APIContext;
		}

		async function termId(taxonomy: string, slug: string) {
			const term = await new TaxonomyRepository(ctx.db).findBySlug(taxonomy, slug, "en");
			if (!term) throw new Error(`No term ${slug}`);
			return term.id;
		}

		async function readTerms(id: string, user: { id: string; role: RoleLevel }) {
			const response = await getEntryTerms(routeContext(id, "category", user));
			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { terms: Array<{ slug: string }> } };
			return body.data.terms.map((term) => term.slug).toSorted();
		}

		it("stages a published entry's terms in its draft", async () => {
			const id = await createPublished("Route staged");

			const response = await postEntryTerms(
				routeContext(id, "category", editor, [await termId("category", "guides")]),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				data: { staged: boolean; _rev?: string; terms: Array<{ slug: string }> };
			};
			expect(body.data.staged).toBe(true);
			expect(body.data._rev).toEqual(expect.any(String));
			expect(body.data.terms.map((term) => term.slug)).toEqual(["guides"]);
			expect(await liveTermSlugs(id, "category")).toEqual(["news"]);
			expect((await draftData(id))?._terms).toEqual({ category: [group.guides] });
			const entry = await new ContentRepository(ctx.db).findById("post", id);
			expect(entry?.draftRevisionId).not.toBeNull();
			expect(entry?.draftRevisionId).not.toBe(entry?.liveRevisionId);
		});

		it("writes a never-published entry's terms directly", async () => {
			const created = ok(
				await runtime.handleContentCreate("post", { data: { title: "Fresh" }, slug: "fresh" }),
			);
			const id = created.item.id;

			const response = await postEntryTerms(
				routeContext(id, "category", editor, [await termId("category", "guides")]),
			);

			expect(response.status).toBe(200);
			const body = (await response.json()) as { data: { staged: boolean } };
			expect(body.data.staged).toBe(false);
			expect(await liveTermSlugs(id, "category")).toEqual(["guides"]);
			expect((await draftData(id))?._terms).toBeUndefined();
		});

		it("applies the staged terms when the entry is published", async () => {
			const id = await createPublished("Route publish");
			await postEntryTerms(
				routeContext(id, "category", editor, [
					await termId("category", "guides"),
					await termId("category", "news"),
				]),
			);

			ok(await runtime.handleContentPublish("post", id));

			expect(await liveTermSlugs(id, "category")).toEqual(["guides", "news"]);
			expect(await liveTermSlugs(id, "tag")).toEqual(["ai"]);
		});

		it("shows staged terms to a draft reader and live terms to anyone else", async () => {
			const id = await createPublished("Route read");
			await postEntryTerms(
				routeContext(id, "category", editor, [await termId("category", "guides")]),
			);

			expect(await readTerms(id, editor)).toEqual(["guides"]);
			expect(await readTerms(id, subscriber)).toEqual(["news"]);
		});
	});
});
