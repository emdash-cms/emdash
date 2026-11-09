import { describe, expectTypeOf, it } from "vitest";

import { getEmDashCollection, type CollectionFilter } from "../../src/query.js";

// The shape `generateTypesFile` emits: system fields around the collection's own.
interface Card {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	excerpt?: string;
	body: unknown[];
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	terms?: Record<string, unknown[]>;
}

declare module "../../src/query.js" {
	interface EmDashCollections {
		cards: Card;
	}
}

describe("getEmDashCollection fields", () => {
	it("keeps the full type without fields", async () => {
		const { entries } = await getEmDashCollection("cards", { limit: 3 });
		expectTypeOf(entries[0]!.data).toEqualTypeOf<Card>();
	});

	it("narrows to the named fields plus the system fields", async () => {
		const { entries } = await getEmDashCollection("cards", { fields: ["title", "excerpt"] });
		expectTypeOf(entries[0]!.data).toEqualTypeOf<
			Pick<
				Card,
				| "title"
				| "excerpt"
				| "id"
				| "slug"
				| "status"
				| "createdAt"
				| "updatedAt"
				| "publishedAt"
				| "terms"
			>
		>();
		expectTypeOf(entries[0]!.data).not.toHaveProperty("body");
	});

	it("rejects a name that is not a field of the collection", async () => {
		// @ts-expect-error - `titel` is not a field of cards
		await getEmDashCollection("cards", { fields: ["titel"] });
	});

	it("accepts the system fields every entry carries", async () => {
		const { entries } = await getEmDashCollection("cards", { fields: ["title", "createdAt"] });
		expectTypeOf(entries[0]!.data.createdAt).toEqualTypeOf<Date>();
	});

	it("keeps the full type for a list widened to string[]", async () => {
		const names: string[] = ["title"];
		const { entries } = await getEmDashCollection("cards", { fields: names });
		expectTypeOf(entries[0]!.data).toEqualTypeOf<Card>();
	});

	it("accepts a CollectionFilter variable, and a spread of one, on a typed collection", async () => {
		const filter: CollectionFilter = { limit: 3 };
		const plain = await getEmDashCollection("cards", filter);
		expectTypeOf(plain.entries[0]!.data).toEqualTypeOf<Card>();
		const spread = await getEmDashCollection("cards", { ...filter, status: "published" });
		expectTypeOf(spread.entries[0]!.data).toEqualTypeOf<Card>();
	});

	it("leaves a collection without generated types loose", async () => {
		const { entries } = await getEmDashCollection("widgets", { fields: ["anything"] });
		expectTypeOf(entries[0]!.data).toEqualTypeOf<Record<string, unknown>>();
	});

	it("keeps the full type when the type arguments are explicit", async () => {
		const { entries } = await getEmDashCollection<"cards", Card>("cards", { fields: ["title"] });
		expectTypeOf(entries[0]!.data).toEqualTypeOf<Card>();
	});
});
