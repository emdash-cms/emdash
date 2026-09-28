import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

function alignedBlock(key: string, textAlign: string | undefined, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		...(textAlign ? { textAlign } : {}),
		markDefs: [],
		children: [{ _type: "span", _key: `${key}-span`, text, marks: [] }],
	};
}

async function render(value: unknown[]) {
	const container = await AstroContainer.create();
	return container.renderToString(PortableText, { props: { value } });
}

function paragraphTags(html: string): string[] {
	return html.match(/<p\b[^>]*>/g) ?? [];
}

describe("PortableText text alignment", () => {
	it.each(["center", "right", "justify"] as const)(
		"marks %s-aligned blocks with the matching alignment class",
		async (align) => {
			const html = await render([alignedBlock("aligned", align, "Aligned")]);
			const [p] = paragraphTags(html);

			expect(p).toContain(`has-text-align-${align}`);
		},
	);

	it("keeps default-aligned blocks free of any alignment class", async () => {
		const html = await render([alignedBlock("plain", undefined, "Plain")]);
		const [p] = paragraphTags(html);

		expect(p).not.toContain("has-text-align");
	});
});
