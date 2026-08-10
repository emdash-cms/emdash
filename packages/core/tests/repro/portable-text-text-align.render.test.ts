import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

/**
 * Renders PortableText through the container API and pins that the
 * `has-text-align-{value}` classes emitted by the Block override come with
 * the CSS to back them. Astro stamps its scoping attribute
 * (`data-astro-cid-*`) on template elements only when the component
 * carries a scoped `<style>`, so the attribute next to the alignment class
 * is the signal that the rules ship and target the aligned element.
 */

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

describe("PortableText text-align CSS (#2285)", () => {
	it.each(["center", "right", "justify"] as const)(
		"scopes the shipped alignment styles onto has-text-align-%s blocks",
		async (align) => {
			const html = await render([alignedBlock("aligned", align, "Aligned")]);
			const [p] = paragraphTags(html);

			expect(p).toContain(`has-text-align-${align}`);
			expect(p).toMatch(/data-astro-cid-/);
		},
	);

	it("keeps default-aligned blocks free of any alignment class", async () => {
		const html = await render([alignedBlock("plain", undefined, "Plain")]);
		const [p] = paragraphTags(html);

		expect(p).not.toContain("has-text-align");
	});
});
