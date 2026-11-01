/**
 * Renders FormEmbed with textarea fields and pins that the rendered <textarea> content is exactly the field's
 * default value, with no indentation or newlines from the component source leaking in. Leaked whitespace moves
 * the caret to a second line and lets an untouched `required` textarea pass the browser's validation.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test, vi } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";

const definition: PublicFormDefinition = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{
					id: "message",
					type: "textarea",
					label: "Message",
					name: "message",
					required: true,
					width: "full",
				},
				{
					id: "notes",
					type: "textarea",
					label: "Notes",
					name: "notes",
					required: false,
					width: "full",
					defaultValue: "Hello there",
				},
			],
		},
	],
	settings: { spamProtection: "honeypot", submitLabel: "Send" },
	status: "active",
	_turnstileSiteKey: null,
};

vi.mock("emdash/plugin-utils", () => ({ getPublicPluginApiRouteHandler: () => undefined }));
vi.mock("../src/public-definition.js", () => ({
	loadPublicFormDefinition: () => Promise.resolve(definition),
}));

const textareaContent = (html: string, name: string): string | undefined =>
	html.match(new RegExp(`<textarea[^>]*\\sname="${name}"[^>]*>([\\s\\S]*?)</textarea>`))?.[1];

describe("FormEmbed textarea content", () => {
	let html: string;

	beforeAll(async () => {
		const { default: FormEmbed } = await import("../src/astro/FormEmbed.astro");
		const container = await AstroContainer.create();
		html = await container.renderToString(FormEmbed, { props: { node: { formId: "contact" } } });
	});

	test("a textarea without a default value renders empty", () => {
		expect(textareaContent(html, "message")).toBe("");
	});

	test("a textarea with a default value renders exactly that value", () => {
		expect(textareaContent(html, "notes")).toBe("Hello there");
	});
});
