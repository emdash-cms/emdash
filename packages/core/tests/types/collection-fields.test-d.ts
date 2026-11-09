import { describe, expectTypeOf, it } from "vitest";

import { getEmDashCollection } from "../../src/query.js";

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

	it("rejects a list widened to string[] on a typed collection", async () => {
		const names: string[] = ["title"];
		// @ts-expect-error - a widened list cannot be checked against Card
		await getEmDashCollection("cards", { fields: names });
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
