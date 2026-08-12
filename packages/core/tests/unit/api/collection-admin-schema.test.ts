import { describe, expect, it } from "vitest";

import {
	collectionResponseSchema,
	createCollectionBody,
	updateCollectionBody,
} from "../../../src/api/schemas/schema.js";

const oversizedListColumns = ["title", "priority", "owner", "region", "category"];
const maximumListColumns = oversizedListColumns.slice(0, 4);

describe("collection admin list column schemas", () => {
	it("accepts four list columns in create and update requests", () => {
		expect(
			createCollectionBody.safeParse({
				slug: "posts",
				label: "Posts",
				admin: { listColumns: maximumListColumns },
			}).success,
		).toBe(true);
		expect(
			updateCollectionBody.safeParse({
				admin: { listColumns: maximumListColumns },
			}).success,
		).toBe(true);
	});

	it("rejects more than four list columns when creating a collection", () => {
		const result = createCollectionBody.safeParse({
			slug: "posts",
			label: "Posts",
			admin: { listColumns: oversizedListColumns },
		});

		expect(result.success).toBe(false);
	});

	it("rejects more than four list columns when updating a collection", () => {
		const result = updateCollectionBody.safeParse({
			admin: { listColumns: oversizedListColumns },
		});

		expect(result.success).toBe(false);
	});

	it("accepts legacy responses with more than four stored list columns", () => {
		const result = collectionResponseSchema.safeParse({
			item: {
				id: "collection-1",
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
				description: null,
				icon: null,
				admin: { listColumns: oversizedListColumns },
				supports: [],
				source: "manual",
				urlPattern: null,
				hasSeo: false,
				hidden: false,
				sortOrder: null,
				createdAt: "2026-08-10T00:00:00.000Z",
				updatedAt: "2026-08-10T00:00:00.000Z",
			},
		});

		expect(result.success).toBe(true);
	});
});
