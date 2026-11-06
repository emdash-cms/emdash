import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test, vi } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";

const definition: PublicFormDefinition = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{ id: "name", type: "text", label: "Name", name: "name", required: true, width: "full" },
			],
		},
	],
	settings: { spamProtection: "none", submitLabel: "Submit" },
	status: "active",
	_turnstileSiteKey: null,
};

vi.mock("emdash/plugin-utils", () => ({ getPublicPluginApiRouteHandler: () => undefined }));
vi.mock("../src/public-definition.js", () => ({
	loadPublicFormDefinition: () => Promise.resolve(definition),
}));

describe("FormEmbed required marker", () => {
	let html: string;

	beforeAll(async () => {
		const { default: FormEmbed } = await import("../src/astro/FormEmbed.astro");
		const container = await AstroContainer.create();
		html = await container.renderToString(FormEmbed, { props: { node: { formId: "contact" } } });
	});

	test("the asterisk is hidden from assistive technology and carries no English name", () => {
		const marker = html.match(/<span[^>]*class="ec-form-required"[^>]*>/)?.[0];
		expect(marker).toBeDefined();
		expect(marker).toContain('aria-hidden="true"');
		expect(marker).not.toContain("aria-label");
	});

	test("the input still exposes required natively", () => {
		expect(html).toMatch(/<input[^>]*name="name"[^>]*required/);
	});
});
