import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Columns from "../../src/components/Columns.astro";

describe("Columns rendering", () => {
	it("renders images inside a column, not only its text", async () => {
		const node = {
			_type: "columns",
			_key: "columns",
			columns: [
				{
					_type: "column",
					_key: "left",
					content: [
						{
							_type: "image",
							_key: "photo",
							asset: { _ref: "photo", url: "https://example.com/photo.jpg" },
							alt: "Museum hall",
						},
					],
				},
				{
					_type: "column",
					_key: "right",
					content: [
						{
							_type: "block",
							_key: "text",
							style: "normal",
							markDefs: [],
							children: [{ _type: "span", _key: "span", text: "Opening hours", marks: [] }],
						},
					],
				},
			],
		};

		const container = await AstroContainer.create();
		const html = await container.renderToString(Columns, { props: { node } });

		expect(html).toMatch(/<img[^>]+alt="Museum hall"/);
		expect(html).toContain("Opening hours");
	});
});
