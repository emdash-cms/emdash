import { describe, it, expect } from "vitest";

import { wxrSource } from "../../../src/import/sources/wxr.js";
import type { NormalizedItem } from "../../../src/import/types.js";

function item(slug: string, status: string, password: string): string {
	return `<item>
			<title>${slug}</title>
			<wp:post_type>post</wp:post_type>
			<wp:status>${status}</wp:status>
			<wp:post_name>${slug}</wp:post_name>
			<wp:post_password><![CDATA[${password}]]></wp:post_password>
		</item>`;
}

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
	<channel><title>Test</title><link>https://example.com</link>
		${item("public", "publish", "")}
		${item("protected", "publish", "secret")}
		${item("protected-scheduled", "future", "secret")}
	</channel>
</rss>`;

async function fetchStatuses(includeDrafts: boolean): Promise<Array<[string, string]>> {
	const items: NormalizedItem[] = [];
	const file = new File([WXR], "export.xml", { type: "text/xml" });
	for await (const entry of wxrSource.fetchContent(
		{ type: "file", file },
		{ postTypes: ["post"], includeDrafts },
	)) {
		items.push(entry);
	}
	return items.map((entry) => [entry.slug, entry.status]);
}

describe("wxrSource password-protected posts", () => {
	it("normalizes them as private", async () => {
		expect(await fetchStatuses(true)).toEqual([
			["public", "publish"],
			["protected", "private"],
			["protected-scheduled", "private"],
		]);
	});

	it("skips them with the drafts when only published posts are requested", async () => {
		expect(await fetchStatuses(false)).toEqual([["public", "publish"]]);
	});
});
