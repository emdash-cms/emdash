import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { Database } from "../../src/database/types.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("Loader taxonomy subtree filter", (dialectName: DialectName) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let termSeq = 0;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialectName);
		db = ctx.db;
		termSeq = 0;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPost(title: string) {
		const result = await handleContentCreate(db, "post", { data: { title }, status: "published" });
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	// parentId is the parent's translation_group (== parent id for untranslated terms).
	async function term(name: string, slug: string, parentId?: string) {
		const id = `tax_${name}_${slug}_${termSeq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({
				id,
				name,
				slug,
				label: slug,
				translation_group: id,
				parent_id: parentId ?? null,
			} as never)
			.execute();
		return id;
	}

	async function tag(contentId: string, taxonomyId: string) {
		await db
			.insertInto("content_taxonomies" as never)
			.values({ collection: "post", entry_id: contentId, taxonomy_id: taxonomyId } as never)
			.execute();
	}

	function load(where: Record<string, unknown>) {
		const loader = emdashLoader();
		return runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({ filter: { type: "post", where: where as never } }),
		);
	}

	it("matches a term and its descendants (single root)", async () => {
		const region = await term("category", "region");
		const north = await term("category", "north", region);
		const city = await term("category", "city", north);

		const rootPost = await createPost("Tagged at root");
		const leafPost = await createPost("Tagged at leaf");
		const outsidePost = await createPost("Outside subtree");
		const other = await term("category", "south", region);

		await tag(rootPost.id, north);
		await tag(leafPost.id, city);
		await tag(outsidePost.id, other);

		const result = await load({ category: { subtree: "north" } });

		const titles = result.entries.map((e) => e.data.title).toSorted();
		expect(titles).toEqual(["Tagged at leaf", "Tagged at root"]);
	});

	it("matches the union of several roots", async () => {
		const region = await term("category", "region");
		const north = await term("category", "north", region);
		const south = await term("category", "south", region);
		const east = await term("category", "east", region);

		const np = await createPost("north");
		const sp = await createPost("south");
		const ep = await createPost("east");
		await tag(np.id, north);
		await tag(sp.id, south);
		await tag(ep.id, east);

		const result = await load({ category: { subtree: ["north", "south"] } });
		const titles = result.entries.map((e) => e.data.title).toSorted();
		expect(titles).toEqual(["north", "south"]);
	});

	it("matches a subtree with more than 100 descendants (no bind-param overflow)", async () => {
		const region = await term("category", "region");
		const leaves: string[] = [];
		for (let i = 0; i < 150; i++) {
			leaves.push(await term("category", `leaf-${i}`, region));
		}
		const post = await createPost("deep");
		await tag(post.id, leaves[120]!); // tagged under one deep leaf

		// Selecting the root must match via the descendant without enumerating
		// 150 slugs as bound parameters.
		const result = await load({ category: { subtree: "region" } });
		expect(result.entries.map((e) => e.data.title)).toEqual(["deep"]);
	});

	it("combines a subtree filter with an exact filter across two taxonomies", async () => {
		const region = await term("category", "region");
		const north = await term("category", "north", region);
		const featured = await term("tag", "featured");

		const both = await createPost("north + featured");
		const northOnly = await createPost("north only");
		await tag(both.id, north);
		await tag(both.id, featured);
		await tag(northOnly.id, north);

		const result = await load({ category: { subtree: "region" }, tag: ["featured"] });
		expect(result.entries.map((e) => e.data.title)).toEqual(["north + featured"]);
	});

	it("an empty subtree roots array matches nothing", async () => {
		const region = await term("category", "region");
		const post = await createPost("anything");
		await tag(post.id, region);

		const result = await load({ category: { subtree: [] } });
		expect(result.entries).toHaveLength(0);
	});

	it("matches descendants tagged in a different locale (match is by group)", async () => {
		// Parent + child share a group across locales: the "en" child and its
		// "de" translation share translation_group; content tagged by group
		// matches regardless of the term row's locale.
		const region = await term("category", "region");
		const childGroup = `grp_child_${termSeq}`;
		const childEn = `tax_en_child_${termSeq++}`;
		const childDe = `tax_de_child_${termSeq++}`;
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: childEn,
				name: "category",
				slug: "child-en",
				label: "child",
				translation_group: childGroup,
				parent_id: region,
				locale: "en",
			} as never)
			.execute();
		await db
			.insertInto("taxonomies" as never)
			.values({
				id: childDe,
				name: "category",
				slug: "child-de",
				label: "child",
				translation_group: childGroup,
				parent_id: region,
				locale: "de",
			} as never)
			.execute();

		const post = await createPost("tagged by group");
		await tag(post.id, childGroup); // content_taxonomies stores the group

		const result = await load({ category: { subtree: "region" } });
		expect(result.entries.map((e) => e.data.title)).toEqual(["tagged by group"]);
	});

	it("paginates a subtree filter with limit and cursor", async () => {
		const region = await term("category", "region");
		const north = await term("category", "north", region);
		for (let i = 0; i < 3; i++) {
			const p = await createPost(`p${i}`);
			await tag(p.id, north);
		}

		const loader = emdashLoader();
		const first = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: { type: "post", where: { category: { subtree: "region" } } as never, limit: 2 },
			}),
		);
		expect(first.entries).toHaveLength(2);
		expect(first.nextCursor).toBeTruthy();

		const second = await runWithContext({ editMode: false, db }, () =>
			loader.loadCollection!({
				filter: {
					type: "post",
					where: { category: { subtree: "region" } } as never,
					limit: 2,
					cursor: first.nextCursor,
				},
			}),
		);
		expect(second.entries).toHaveLength(1);
	});
});
