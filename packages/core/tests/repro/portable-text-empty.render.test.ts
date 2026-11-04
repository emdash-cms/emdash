import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

it.each([undefined, null])("PortableText renders empty content for %s", async (value) => {
	const container = await AstroContainer.create();
	const html = await container.renderToString(PortableText, { props: { value } });
	expect(html.trim()).toBe("");
});
