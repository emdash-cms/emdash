import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import Columns from "../../src/components/Columns.astro";
import Cover from "../../src/components/Cover.astro";

const nestedContent = [
	{
		_type: "block",
		_key: "paragraph",
		style: "normal",
		markDefs: [
			{
				_type: "link",
				_key: "unsafe-link",
				href: "javascript:document.body.dataset.compromised='true'",
			},
		],
		children: [
			{
				_type: "span",
				_key: "text",
				text: "Unsafe link",
				marks: ["unsafe-link"],
			},
		],
	},
];

describe("nested Portable Text links", () => {
	it.each([
		{
			name: "columns",
			component: Columns,
			node: {
				_type: "columns",
				_key: "columns",
				columns: [{ _type: "column", _key: "column", content: nestedContent }],
			},
		},
		{
			name: "cover",
			component: Cover,
			node: { _type: "cover", _key: "cover", content: nestedContent },
		},
	])("sanitizes link destinations inside $name blocks", async ({ component, node }) => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(component, { props: { node } });

		expect(html).toContain('href="#"');
		expect(html).not.toContain("javascript:");
	});
});
