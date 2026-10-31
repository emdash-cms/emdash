import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test, vi } from "vitest";

import type { PublicFormDefinition } from "../src/public-definition.js";

const options = [
	{ label: "Tokyo", value: "tokyo" },
	{ label: "Osaka", value: "osaka" },
];

const definition: PublicFormDefinition = {
	name: "Apply",
	slug: "apply",
	pages: [
		{
			fields: [
				{
					id: "office",
					type: "select",
					label: "Office",
					name: "office",
					required: true,
					width: "full",
					options,
				},
				{
					id: "branch",
					type: "select",
					label: "Branch",
					name: "branch",
					placeholder: "Choose a branch",
					required: true,
					width: "full",
					options,
				},
				{
					id: "preferred",
					type: "select",
					label: "Preferred",
					name: "preferred",
					required: true,
					width: "full",
					defaultValue: "osaka",
					options,
				},
				{
					id: "optional",
					type: "select",
					label: "Optional",
					name: "optional",
					required: false,
					width: "full",
					options,
				},
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

interface RenderedOption {
	value: string;
	label: string;
	selected: boolean;
}

function optionsOf(html: string, name: string): RenderedOption[] {
	const select = html.match(
		new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`),
	)?.[1];
	if (select === undefined) throw new Error(`No select named ${name}`);
	return Array.from(
		select.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g),
		([, attrs, label]) => ({
			value: attrs!.match(/value="([^"]*)"/)?.[1] ?? "",
			label: label!.trim(),
			selected: /\sselected\b/.test(attrs!),
		}),
	);
}

describe("FormEmbed select", () => {
	let html: string;

	beforeAll(async () => {
		const { default: FormEmbed } = await import("../src/astro/FormEmbed.astro");
		const container = await AstroContainer.create();
		html = await container.renderToString(FormEmbed, { props: { node: { formId: "apply" } } });
	});

	test("a required select without a default starts on an empty option", () => {
		expect(optionsOf(html, "office")).toEqual([
			{ value: "", label: "", selected: true },
			{ value: "tokyo", label: "Tokyo", selected: false },
			{ value: "osaka", label: "Osaka", selected: false },
		]);
	});

	test("the empty option shows the field's placeholder when it has one", () => {
		expect(optionsOf(html, "branch")[0]).toEqual({
			value: "",
			label: "Choose a branch",
			selected: true,
		});
	});

	test("a required select with a default keeps the default and no empty option", () => {
		expect(optionsOf(html, "preferred")).toEqual([
			{ value: "tokyo", label: "Tokyo", selected: false },
			{ value: "osaka", label: "Osaka", selected: true },
		]);
	});

	test("an optional select is unchanged", () => {
		expect(optionsOf(html, "optional").map((o) => o.value)).toEqual(["tokyo", "osaka"]);
	});
});
