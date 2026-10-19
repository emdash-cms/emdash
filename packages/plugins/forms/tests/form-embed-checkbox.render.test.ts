/**
 * Regression check for the single checkbox layout bug: the individual checkbox input
 * must not carry `ec-form-input`, because that class applies `width: 100%` and stretches
 * the box across the flex row inside `.ec-form-checkbox-label`, pushing the label away.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test, vi } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";

const definition: PublicFormDefinition = {
	name: "Consent",
	slug: "consent",
	pages: [
		{
			fields: [
				{
					id: "consent",
					type: "checkbox",
					label:
						"I agree to the long privacy policy statement spanning enough text to reveal stretching.",
					name: "consent",
					required: true,
					width: "full",
				},
			],
		},
	],
	settings: { spamProtection: "honeypot", submitLabel: "Submit" },
	status: "active",
	_turnstileSiteKey: null,
};

vi.mock("emdash/plugin-utils", () => ({ getPublicPluginApiRouteHandler: () => undefined }));
vi.mock("../src/public-definition.js", () => ({
	loadPublicFormDefinition: () => Promise.resolve(definition),
}));

describe("FormEmbed checkbox", () => {
	let html: string;

	beforeAll(async () => {
		const { default: FormEmbed } = await import("../src/astro/FormEmbed.astro");
		const container = await AstroContainer.create();
		html = await container.renderToString(FormEmbed, { props: { node: { formId: "consent" } } });
	});

	test("single checkbox input does not use the text-input ec-form-input class", () => {
		const checkbox = html.match(/<input[^>]*?type="checkbox"[^>]*?>/)?.[0];
		expect(checkbox).toBeDefined();
		expect(checkbox).not.toContain("ec-form-input");
	});
});
