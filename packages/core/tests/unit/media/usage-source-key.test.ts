import { describe, expect, it } from "vitest";

import {
	buildContentMediaUsageSourceKey,
	isMediaUsageContentSourceVariant,
	MEDIA_USAGE_CONTENT_SOURCE_VARIANTS,
} from "../../../src/media/usage/source-key.js";

describe("media usage content source keys", () => {
	it("uses the content namespace and storage source variant", () => {
		expect(
			buildContentMediaUsageSourceKey({
				collectionSlug: "posts",
				contentId: "entry1",
				sourceVariant: "columns",
			}),
		).toBe("content:posts:entry1:columns");

		expect(
			buildContentMediaUsageSourceKey({
				collectionSlug: "posts",
				contentId: "entry1",
				sourceVariant: "draft_overlay",
			}),
		).toBe("content:posts:entry1:draft_overlay");
	});

	it("keeps publish states out of source variant identity", () => {
		expect(MEDIA_USAGE_CONTENT_SOURCE_VARIANTS).toEqual(["columns", "draft_overlay"]);
		expect(isMediaUsageContentSourceVariant("columns")).toBe(true);
		expect(isMediaUsageContentSourceVariant("draft_overlay")).toBe(true);
		expect(isMediaUsageContentSourceVariant("live")).toBe(false);
		expect(isMediaUsageContentSourceVariant("draft")).toBe(false);
	});
});
