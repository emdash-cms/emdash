import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test, vi } from "vitest";

import { Blocks } from "../../src/ui.js";
import Hero from "./BlockHero.astro";
import Quote from "./BlockQuote.astro";

const compact = (html: string) => html.replace(/\s+/g, " ").trim();

describe("Blocks", () => {
	test("renders empty values without output", async () => {
		const container = await AstroContainer.create();
		await expect(container.renderToString(Blocks, { props: { value: [] } })).resolves.toBe("");
	});

	test("renders mixed types and retained versions in stored order", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Blocks, {
			props: {
				value: [
					{ _type: "hero", _version: 1, _key: "first", heading: "First" },
					{ _type: "quote", _version: 1, _key: "second", text: "Second" },
					{ _type: "hero", _version: 2, _key: "third", title: "Third" },
				],
				components: { hero: Hero, quote: Quote },
			},
		});
		const rendered = compact(html);

		expect(rendered.indexOf("First")).toBeLessThan(rendered.indexOf("Second"));
		expect(rendered.indexOf("Second")).toBeLessThan(rendered.indexOf("Third"));
		expect(rendered).toContain('data-index="0" data-key="first"');
		expect(rendered).toContain('data-index="2" data-key="third"');
	});

	test("shows a development diagnostic without exposing stored values", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const container = await AstroContainer.create();
		const html = await container.renderToString(Blocks, {
			props: {
				value: [
					{
						_type: "missing",
						_version: 7,
						_key: "missing-key",
						secret: "must-not-render",
					},
				],
				components: {},
			},
		});

		expect(html).toContain('data-emdash-missing-block="missing"');
		expect(html).toContain("No component was provided for block type");
		expect(html).not.toContain("must-not-render");
		expect(warning).toHaveBeenCalledWith(
			'[emdash] No component was provided for block type "missing".',
		);
		warning.mockRestore();
	});

	test("renders twenty static blocks without external state", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(Blocks, {
			props: {
				value: Array.from({ length: 20 }, (_, index) => ({
					_type: "quote",
					_version: 1,
					_key: `quote-${index}`,
					text: `Quote ${index}`,
				})),
				components: { quote: Quote },
			},
		});

		expect(html.match(/data-block="quote"/g)).toHaveLength(20);
	});
});
