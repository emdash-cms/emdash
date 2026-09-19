/**
 * Renders FormEmbed twice, the way a page embedding the same form in a rail and a pop-up does, and pins that the
 * two renderings share no element ids.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test, vi } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";

const definition: PublicFormDefinition = {
	name: "Newsletter",
	slug: "newsletter",
	pages: [
		{
			fields: [
				{
					id: "email",
					type: "email",
					label: "Email",
					name: "email",
					required: true,
					width: "full",
				},
				{ id: "name", type: "text", label: "Name", name: "name", required: false, width: "full" },
			],
		},
	],
	settings: { spamProtection: "honeypot", submitLabel: "Subscribe" },
	status: "active",
	_turnstileSiteKey: null,
};

vi.mock("emdash/plugin-utils", () => ({ getPublicPluginApiRouteHandler: () => undefined }));
vi.mock("../src/public-definition.js", () => ({
	loadPublicFormDefinition: () => Promise.resolve(definition),
}));

const idsIn = (html: string): string[] => Array.from(html.matchAll(/\sid="([^"]+)"/g), (m) => m[1]);
const labelTargetsIn = (html: string): string[] =>
	Array.from(html.matchAll(/<label[^>]*\sfor="([^"]+)"/g), (m) => m[1]);

describe("FormEmbed element ids", () => {
	let first: string;
	let second: string;

	beforeAll(async () => {
		const { default: FormEmbed } = await import("../src/astro/FormEmbed.astro");
		const container = await AstroContainer.create();
		const render = () =>
			container.renderToString(FormEmbed, { props: { node: { formId: "newsletter" } } });
		first = await render();
		second = await render();
	});

	test("two renderings of the same form share no element ids", () => {
		const a = idsIn(first);
		const b = idsIn(second);
		expect(a.length).toBeGreaterThan(0);
		expect(a.filter((id) => b.includes(id))).toEqual([]);
	});

	test("ids are unique within a rendering", () => {
		const a = idsIn(first);
		expect(new Set(a).size).toBe(a.length);
	});

	test("every label points at an input in its own rendering", () => {
		for (const [html, which] of [
			[first, "first"],
			[second, "second"],
		] as const) {
			const ids = new Set(idsIn(html));
			const targets = labelTargetsIn(html);
			expect(targets.length, `${which} rendering has labels`).toBeGreaterThan(0);
			for (const target of targets) {
				expect(ids.has(target), `${which}: label for="${target}" matches an id`).toBe(true);
			}
		}
	});
});
