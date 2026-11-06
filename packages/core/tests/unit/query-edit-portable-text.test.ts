import { it, expect, beforeEach, afterEach, vi } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { getEditMeta, getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

/**
 * `<PortableText>` renders the inline editor only for a value carrying edit
 * metadata. An empty body — never written (`null`, or no key in a draft
 * revision), cleared (`[]`), or left blank by an import (`""`) — must still
 * carry it, or there is nothing on the page to click and write into.
 */
describeEachDialect("empty Portable Text fields in edit mode", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.mocked(getLiveCollection).mockReset();
		vi.mocked(getLiveEntry).mockReset();
	});

	async function seedPost(slug: string) {
		const result = await handleContentCreate(ctx.db, "post", {
			data: { title: slug },
			slug,
			status: "published",
		});
		if (!result.success) throw new Error("Failed to create post");
		return result.data!.item;
	}

	function loadedEntry(item: { id: string; slug: string | null }, data: Record<string, unknown>) {
		return { id: item.slug, data: { id: item.id, status: "published", ...data } };
	}

	it("gives a never-written body an editable empty value on a detail page", async () => {
		const item = await seedPost("never-written");
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: loadedEntry(item, { title: null, content: null }),
			error: undefined,
			cacheHint: {},
		} as never);

		const { entry } = await runWithContext({ editMode: true, db: ctx.db }, () =>
			getEmDashEntry("post", "never-written"),
		);

		expect(entry!.data.content).toEqual([]);
		expect(getEditMeta(entry!.data.content)).toEqual({
			collection: "post",
			id: item.id,
			field: "content",
		});
		expect(entry!.data.title).toBeNull();
	});

	it("gives missing, cleared and blank bodies an editable empty value on a list page", async () => {
		const missing = await seedPost("missing");
		const cleared = await seedPost("cleared");
		const blank = await seedPost("blank");
		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: [
				loadedEntry(missing, { title: "Missing" }),
				loadedEntry(cleared, { content: [] }),
				loadedEntry(blank, { content: " " }),
			],
			error: undefined,
			cacheHint: {},
		} as never);

		const { entries } = await runWithContext({ editMode: true, db: ctx.db }, () =>
			getEmDashCollection("post"),
		);

		expect(entries.map((entry) => entry.data.content)).toEqual([[], [], []]);
		expect(entries.map((entry) => getEditMeta(entry.data.content)?.id)).toEqual([
			missing.id,
			cleared.id,
			blank.id,
		]);
	});

	it("leaves an empty body alone outside edit mode", async () => {
		const item = await seedPost("published-view");
		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: loadedEntry(item, { title: "Published", content: null }),
			error: undefined,
			cacheHint: {},
		} as never);

		const { entry } = await runWithContext({ editMode: false, db: ctx.db }, () =>
			getEmDashEntry("post", "published-view"),
		);

		expect(entry!.data.content).toBeNull();
	});
});
