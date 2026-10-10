import { describe, expect, it } from "vitest";

import { POST as analyzePost } from "../../../src/astro/routes/api/import/wordpress/analyze.js";

const ACF_POST_TYPES = [
	"acf-field-group",
	"acf-field",
	"acf-post-type",
	"acf-taxonomy",
	"acf-ui-options-page",
];

function makeWxr(postTypes: string[]): string {
	const items = postTypes
		.map(
			(type, i) => `<item>
			<title>Item ${i + 1}</title>
			<wp:post_id>${i + 1}</wp:post_id>
			<wp:post_type>${type}</wp:post_type>
			<wp:status>publish</wp:status>
			<wp:post_name>item-${i + 1}</wp:post_name>
			<content:encoded><![CDATA[a:1:{s:4:"type";s:4:"text";}]]></content:encoded>
		</item>`,
		)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
	<channel>
		<title>Test Site</title>
		<link>https://example.com</link>
		${items}
	</channel>
</rss>`;
}

describe("POST /import/wordpress/analyze", () => {
	it("leaves ACF's internal post types out of the importable post types", async () => {
		const formData = new FormData();
		formData.append(
			"file",
			new File([makeWxr(["post", ...ACF_POST_TYPES])], "export.xml", { type: "text/xml" }),
		);
		const response = await analyzePost(
			// eslint-disable-next-line typescript/no-unsafe-type-assertion
			{
				request: new Request("http://localhost/_emdash/api/import/wordpress/analyze", {
					method: "POST",
					body: formData,
				}),
				locals: { user: { id: "test-admin", role: 50 } },
			} as any,
		);

		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { postTypes: { name: string }[] } };
		expect(data.postTypes.map((pt) => pt.name)).toEqual(["post"]);
	});
});
