import { sql } from "kysely";
import { beforeEach, afterEach, expect, it } from "vitest";

import { handleContentCreate, handleContentList } from "../../../src/api/handlers/content.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// Byline filtering in the admin content list: match entries credited to any of
// the selected bylines, or entries with no byline at all. Credits inferred from
// an entry's author are excluded unless explicitly opted into.
describeEachDialect("content list byline filter", (dialect) => {
	let ctx: DialectTestContext;
	// `_emdash_content_bylines.byline_id` stores translation_groups, so the
	// filter takes groups rather than row ids.
	let adaGroup: string;
	let graceGroup: string;
	let turingGroup: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const users = new UserRepository(ctx.db);
		const turingUser = await users.create({ email: "turing@example.com", name: "Turing" });

		const bylines = new BylineRepository(ctx.db);
		const ada = await bylines.create({ slug: "ada", displayName: "Ada Lovelace" });
		const grace = await bylines.create({ slug: "grace", displayName: "Grace Hopper" });
		// Linked to a CMS user, so entries authored by that user get an
		// inferred credit when they carry no explicit one.
		const turing = await bylines.create({
			slug: "turing",
			displayName: "Alan Turing",
			userId: turingUser.id,
		});
		adaGroup = ada.translationGroup ?? ada.id;
		graceGroup = grace.translationGroup ?? grace.id;
		turingGroup = turing.translationGroup ?? turing.id;

		const seed = [
			{ slug: "ada-only", title: "Ada only", bylines: [ada.id] },
			{ slug: "grace-only", title: "Grace only", bylines: [grace.id] },
			{ slug: "both", title: "Both", bylines: [ada.id, grace.id] },
			{ slug: "uncredited", title: "Uncredited", bylines: [] },
			// No explicit credit, but its author owns the Turing byline — the
			// list renders "Alan Turing" against it by inference.
			{ slug: "inferred", title: "Inferred", bylines: [], authorId: turingUser.id },
		];
		for (const s of seed) {
			const created = await handleContentCreate(ctx.db, "posts", {
				slug: s.slug,
				data: { title: s.title },
				authorId: s.authorId,
				bylines: s.bylines.map((bylineId) => ({ bylineId })),
			});
			if (!created.success) throw new Error(`seed ${s.slug} failed`);
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function slugsOf(result: {
		success: boolean;
		data?: { items: { slug: string | null }[] };
	}): string[] {
		if (!result.success || !result.data) throw new Error("list failed");
		return result.data.items.map((i) => i.slug ?? "").toSorted();
	}

	it("matches entries credited to the selected byline", async () => {
		const result = await handleContentList(ctx.db, "posts", { bylines: [adaGroup] });
		expect(slugsOf(result)).toEqual(["ada-only", "both"]);
	});

	it("matches entries credited to any of several bylines", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			bylines: [adaGroup, graceGroup],
		});
		expect(slugsOf(result)).toEqual(["ada-only", "both", "grace-only"]);
	});

	it("reports a total that reflects the byline filter", async () => {
		const result = await handleContentList(ctx.db, "posts", { bylines: [adaGroup] });
		if (!result.success) throw new Error("list failed");
		expect(result.data.total).toBe(2);
	});

	it("matches entries with no byline credit", async () => {
		const result = await handleContentList(ctx.db, "posts", { bylinesNone: true });
		// `inferred` has no credit of its own, so it belongs here until
		// inference is opted into.
		expect(slugsOf(result)).toEqual(["inferred", "uncredited"]);
	});

	it("ignores bylines inferred from the author by default", async () => {
		const result = await handleContentList(ctx.db, "posts", { bylines: [turingGroup] });
		expect(slugsOf(result)).toEqual([]);
	});

	it("matches inferred bylines when opted in", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			bylines: [turingGroup],
			includeInferredBylines: true,
		});
		expect(slugsOf(result)).toEqual(["inferred"]);
	});

	it("excludes entries with an inferred byline from the no-byline filter when opted in", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			bylinesNone: true,
			includeInferredBylines: true,
		});
		expect(slugsOf(result)).toEqual(["uncredited"]);
	});

	it("does not infer a credit for an entry that already has one", async () => {
		// `ada-only` is authored by nobody, but the guard matters generally:
		// an explicit credit must suppress the author fallback, mirroring
		// `hydrateBylinesMany`. Credit `inferred` to Ada and it should stop
		// matching Turing even with inference on.
		const bylines = new BylineRepository(ctx.db);
		const ada = await bylines.findBySlug("ada");
		if (!ada) throw new Error("ada byline missing");
		await bylines.setContentBylines("posts", await idOfSlug("inferred"), [{ bylineId: ada.id }]);

		const result = await handleContentList(ctx.db, "posts", {
			bylines: [turingGroup],
			includeInferredBylines: true,
		});
		expect(slugsOf(result)).toEqual([]);
	});

	it("resolves inferred credits at the locale the list is scoped to", async () => {
		// A byline translated into `fr` starts with a null user_id (the
		// translations route makes linking an explicit step), so the Turing
		// byline is user-linked at the default locale only. Move `inferred`
		// to `fr` and the list renders no byline against it — the author
		// fallback is strict per locale. The filter has to agree, or it
		// returns an entry the list shows as uncredited.
		const id = await idOfSlug("inferred");
		const bylines = new BylineRepository(ctx.db);
		const turing = await bylines.findBySlug("turing");
		if (!turing) throw new Error("turing byline missing");
		await bylines.create({
			slug: "turing-fr",
			displayName: "Alan Turing",
			locale: "fr",
			translationOf: turing.id,
		});
		await sql`UPDATE ${sql.ref("ec_posts")} SET locale = 'fr' WHERE id = ${id}`.execute(ctx.db);

		const list = await handleContentList(ctx.db, "posts", { locale: "fr" });
		if (!list.success) throw new Error("list failed");
		expect(list.data.items.find((i) => i.slug === "inferred")?.bylines).toEqual([]);

		const matched = await handleContentList(ctx.db, "posts", {
			locale: "fr",
			bylines: [turingGroup],
			includeInferredBylines: true,
		});
		expect(slugsOf(matched)).toEqual([]);

		// The same entry must not fall through the gap either: with nothing
		// rendered against it, it belongs under "no byline".
		const none = await handleContentList(ctx.db, "posts", {
			locale: "fr",
			bylinesNone: true,
			includeInferredBylines: true,
		});
		expect(slugsOf(none)).toEqual(["inferred"]);
	});

	it("ignores an explicit credit that does not resolve at the list's locale", async () => {
		// Junction rows are copied to every translation of an entry
		// (`copyContentBylines`) and store a translation_group, but a credit
		// only renders where the group has a row at the list's locale. Ada
		// exists in the default locale only, so an `fr` entry credited to her
		// renders uncredited — and the filter has to agree in both directions.
		const id = await idOfSlug("ada-only");
		await sql`UPDATE ${sql.ref("ec_posts")} SET locale = 'fr' WHERE id = ${id}`.execute(ctx.db);

		const list = await handleContentList(ctx.db, "posts", { locale: "fr" });
		if (!list.success) throw new Error("list failed");
		expect(list.data.items.find((i) => i.slug === "ada-only")?.bylines).toEqual([]);

		const matched = await handleContentList(ctx.db, "posts", {
			locale: "fr",
			bylines: [adaGroup],
		});
		expect(slugsOf(matched)).toEqual([]);

		const none = await handleContentList(ctx.db, "posts", { locale: "fr", bylinesNone: true });
		expect(slugsOf(none)).toEqual(["ada-only"]);
	});

	it("does not infer a credit for an entry whose explicit credit fails to resolve", async () => {
		// The entry carries an explicit credit that renders nothing at `fr`,
		// and its author owns a byline that does exist at `fr`. Hydration still
		// shows no credit: the author fallback applies only where the entry has
		// no explicit credit at all, at any locale. So the inference gate stays
		// locale-agnostic even though what renders is locale-scoped.
		const bylines = new BylineRepository(ctx.db);
		const ada = await bylines.findBySlug("ada");
		const turing = await bylines.findBySlug("turing");
		if (!ada || !turing) throw new Error("byline missing");
		await bylines.create({
			slug: "turing-fr",
			displayName: "Alan Turing",
			locale: "fr",
			translationOf: turing.id,
			userId: turing.userId ?? undefined,
		});

		const created = await handleContentCreate(ctx.db, "posts", {
			slug: "credited-fr",
			data: { title: "Credited FR" },
			authorId: turing.userId ?? undefined,
			bylines: [{ bylineId: ada.id }],
		});
		if (!created.success) throw new Error("seed credited-fr failed");
		await sql`UPDATE ${sql.ref("ec_posts")} SET locale = 'fr' WHERE id = ${
			created.data.item.id
		}`.execute(ctx.db);

		const list = await handleContentList(ctx.db, "posts", { locale: "fr" });
		if (!list.success) throw new Error("list failed");
		expect(list.data.items.find((i) => i.slug === "credited-fr")?.bylines).toEqual([]);

		const matched = await handleContentList(ctx.db, "posts", {
			locale: "fr",
			bylines: [turingGroup],
			includeInferredBylines: true,
		});
		expect(slugsOf(matched)).toEqual([]);

		const none = await handleContentList(ctx.db, "posts", {
			locale: "fr",
			bylinesNone: true,
			includeInferredBylines: true,
		});
		expect(slugsOf(none)).toEqual(["credited-fr"]);
	});

	it("composes with the status filter", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			bylines: [adaGroup, graceGroup],
			status: "published",
		});
		// Seeded entries are drafts, so the intersection is empty — the byline
		// filter must not override the status filter.
		expect(slugsOf(result)).toEqual([]);
	});

	it("matches nothing when the selected byline has no entries", async () => {
		const result = await handleContentList(ctx.db, "posts", {
			bylines: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"],
		});
		expect(slugsOf(result)).toEqual([]);
	});

	it("matches nothing when a repository caller passes an empty byline list", async () => {
		// The handler never builds this, but a filter that resolved to no ids
		// must not degrade into "no filter" and return the whole collection.
		const repo = new ContentRepository(ctx.db);
		const result = await repo.findMany("posts", {
			where: { bylineFilter: { mode: "any", bylineIds: [] } },
		});
		expect(result.items).toEqual([]);
		expect(result.total).toBe(0);
	});

	async function idOfSlug(slug: string): Promise<string> {
		const list = await handleContentList(ctx.db, "posts", {});
		if (!list.success) throw new Error("list failed");
		const item = list.data.items.find((i) => i.slug === slug);
		if (!item) throw new Error(`no entry with slug ${slug}`);
		return item.id;
	}
});
