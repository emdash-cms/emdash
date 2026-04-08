import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { ContentItem, Revision } from "../../src/lib/api";
import { applyAutosaveResultToQueryCache } from "../../src/lib/autosave-cache";

function makeContentItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "post-1",
		type: "posts",
		slug: "draft-slug",
		status: "published",
		locale: "en",
		translationGroup: "post-1",
		data: {
			title: "Updated title",
			excerpt: "Updated excerpt",
		},
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-04-01T00:00:00.000Z",
		updatedAt: "2026-04-05T00:00:00.000Z",
		publishedAt: "2026-04-01T00:00:00.000Z",
		scheduledAt: null,
		liveRevisionId: "rev-live",
		draftRevisionId: "rev-draft",
		...overrides,
	};
}

function makeRevision(overrides: Partial<Revision> = {}): Revision {
	return {
		id: "rev-draft",
		collection: "posts",
		entryId: "post-1",
		data: {
			title: "Old title",
			excerpt: "Old excerpt",
			_slug: "old-slug",
		},
		authorId: null,
		createdAt: "2026-04-04T00:00:00.000Z",
		...overrides,
	};
}

describe("applyAutosaveResultToQueryCache", () => {
	it("updates the cached content item and active draft revision", () => {
		const queryClient = new QueryClient();
		const savedItem = makeContentItem();

		queryClient.setQueryData(
			["content", "posts", "post-1"],
			makeContentItem({ data: { title: "Old title" } }),
		);
		queryClient.setQueryData(["revision", "rev-draft"], makeRevision());

		applyAutosaveResultToQueryCache(queryClient, "posts", "post-1", savedItem);

		expect(queryClient.getQueryData(["content", "posts", "post-1"])).toEqual(savedItem);
		expect(queryClient.getQueryData(["revision", "rev-draft"])).toEqual(
			expect.objectContaining({
				data: {
					title: "Updated title",
					excerpt: "Updated excerpt",
					_slug: "draft-slug",
				},
			}),
		);
	});

	it("leaves an uncached draft revision untouched", () => {
		const queryClient = new QueryClient();
		const savedItem = makeContentItem();

		applyAutosaveResultToQueryCache(queryClient, "posts", "post-1", savedItem);

		expect(queryClient.getQueryData(["content", "posts", "post-1"])).toEqual(savedItem);
		expect(queryClient.getQueryData(["revision", "rev-draft"])).toBeUndefined();
	});
});
