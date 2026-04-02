import { describe, expect, it } from "vitest";

import {
	buildGhostAuthorPostCounts,
	buildGhostPrimaryAuthorByPostId,
	buildGhostTagSlugsByPostId,
	getGhostSettingValue,
	parseGhostExportString,
} from "../../../src/import/ghost/parser.js";

function createGhostExportJson(): string {
	return JSON.stringify({
		db: [
			{
				data: {
					posts: [
						{
							id: "post-1",
							title: "Hello",
							slug: "hello",
							html: "<p>Hello</p>",
							plaintext: "Hello",
							feature_image: "__GHOST_URL__/content/images/2024/01/hello.png",
							type: "post",
							status: "published",
							visibility: "public",
							created_at: "2024-01-01T00:00:00.000Z",
							updated_at: "2024-01-02T00:00:00.000Z",
							published_at: "2024-01-03T00:00:00.000Z",
						},
					],
					tags: [{ id: "tag-1", name: "AI", slug: "ai" }],
					posts_tags: [{ id: "pt-1", post_id: "post-1", tag_id: "tag-1", sort_order: 0 }],
					users: [
						{
							id: "user-1",
							name: "Mason James",
							slug: "mason-james",
							email: "mason@example.com",
						},
					],
					posts_authors: [
						{ id: "pa-1", post_id: "post-1", author_id: "user-1", sort_order: 0 },
					],
					settings: [
						{ id: "setting-1", key: "title", value: "Ghost Site", group: "site", type: "string" },
					],
					posts_meta: [{ id: "meta-1", post_id: "post-1", feature_image_alt: "Alt text" }],
					posts_products: [{ id: "pp-1", post_id: "post-1", product_id: "product-1", sort_order: 0 }],
				},
			},
		],
	});
}

describe("Ghost parser", () => {
	it("parses the Ghost export envelope and helper maps", () => {
		const data = parseGhostExportString(createGhostExportJson());

		expect(data.posts).toHaveLength(1);
		expect(data.tags).toHaveLength(1);
		expect(data.postTags).toHaveLength(1);
		expect(data.users).toHaveLength(1);
		expect(data.postAuthors).toHaveLength(1);
		expect(getGhostSettingValue(data, "title")).toBe("Ghost Site");

		expect(buildGhostTagSlugsByPostId(data).get("post-1")).toEqual(["ai"]);
		expect(buildGhostPrimaryAuthorByPostId(data).get("post-1")?.slug).toBe("mason-james");
		expect(buildGhostAuthorPostCounts(data).get("user-1")).toBe(1);
	});

	it("throws for invalid Ghost export shape", () => {
		expect(() => parseGhostExportString(JSON.stringify({ db: [] }))).toThrow(
			"Invalid Ghost export shape: db[0] not found",
		);
		expect(() => parseGhostExportString("{not json}")).toThrow("Invalid Ghost export JSON");
	});
});
