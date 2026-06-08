import { describe, expect, it } from "vitest";

import { buildLiveSearchResultUrl } from "../../../src/components/live-search-routing.js";

describe("buildLiveSearchResultUrl", () => {
	it("uses the default collection URL when no route template exists", () => {
		expect(
			buildLiveSearchResultUrl({
				collection: "posts",
				id: "post-1",
				slug: "hello-world",
			}),
		).toBe("/posts/hello-world");
	});

	it("falls back to the id when a result has no slug", () => {
		expect(
			buildLiveSearchResultUrl({
				collection: "products",
				id: "product-1",
				slug: null,
			}),
		).toBe("/products/product-1");
	});

	it("applies collection route templates", () => {
		expect(
			buildLiveSearchResultUrl(
				{
					collection: "games",
					id: "game-1",
					slug: "mausritter",
				},
				{
					games: "/item/:slug",
				},
			),
		).toBe("/item/mausritter");
	});

	it("replaces all supported route template tokens", () => {
		expect(
			buildLiveSearchResultUrl(
				{
					collection: "games",
					id: "game-1",
					slug: null,
				},
				{
					games: "/:collection/:id/:slug/:path",
				},
			),
		).toBe("/games/game-1/game-1/game-1");
	});
});
