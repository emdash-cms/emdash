import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it } from "vitest";

import PortableText from "../../src/components/PortableText.astro";

it.each([undefined, null])(
	"renders %s CMS content like an empty Portable Text array",
	async (value) => {
		const container = await AstroContainer.create();
		const unset = await container.renderToString(PortableText, { props: { value } });
		const empty = await container.renderToString(PortableText, { props: { value: [] } });

		expect(unset).toBe(empty);
		expect(unset.trim()).toBe("");
	},
);
