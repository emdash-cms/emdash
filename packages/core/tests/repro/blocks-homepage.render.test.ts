import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterEach, describe, expect, test, vi } from "vitest";

import { Blocks } from "../../src/ui.js";
import Features from "./HomeFeatures.astro";
import Hero from "./HomeHero.astro";
import Quote from "./HomeQuote.astro";

const components = { hero: Hero, features: Features, quote: Quote };
const typical = [
	{
		_type: "hero",
		_version: 1,
		_key: "home-hero",
		heading: "Build the page from structured content",
		body: [
			{
				_type: "block",
				_key: "hero-body",
				style: "normal",
				children: [{ _type: "span", _key: "hero-span", text: "Editors control every word." }],
			},
		],
		link_label: "Read the guide",
		link_url: "/guides/blocks",
		image: {
			id: "home-hero-image",
			src: "https://example.com/home-hero.jpg",
			alt: "A structured homepage composition",
		},
	},
	{
		_type: "features",
		_version: 1,
		_key: "home-features",
		heading: "Included sections",
		items: [
			{ title: "Typed", description: "Each block follows a retained schema version." },
			{ title: "Ordered", description: "Editors choose the page sequence." },
		],
	},
	{
		_type: "quote",
		_version: 1,
		_key: "home-quote",
		text: "The template contains structure, not page copy.",
		attribution: "Homepage editor",
	},
];

async function render(value: unknown[]) {
	const container = await AstroContainer.create();
	return container.renderToString(Blocks, { props: { value, components } });
}

describe("blocks homepage fixture", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("renders copy, links, Portable Text, media, repeaters, optional fields, and order from data", async () => {
		const html = await render(typical);

		expect(html.indexOf("Build the page")).toBeLessThan(html.indexOf("Included sections"));
		expect(html.indexOf("Included sections")).toBeLessThan(html.indexOf("The template contains"));
		expect(html).toContain('href="/guides/blocks"');
		expect(html).toContain('src="https://example.com/home-hero.jpg"');
		expect(html).toContain("Editors control every word.");
		expect(html).toContain("Each block follows a retained schema version.");
		expect(html).toContain("Homepage editor");
	});

	test("reflects an edited block without changing the page component", async () => {
		const edited = structuredClone(typical);
		edited[0]!.heading = "Changed in the content editor";

		expect(await render(edited)).toContain("Changed in the content editor");
	});

	test.each([0, 1, 20, 100])(
		"renders %i static blocks without hidden network access",
		async (count) => {
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
			const values = Array.from({ length: count }, (_, index) => ({
				_type: "quote",
				_version: 1,
				_key: `quote-${index}`,
				text: `Quote ${index}`,
			}));

			const html = await render(values);
			expect(html.match(/data-home-block="quote"/g) ?? []).toHaveLength(count);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	test("records empty, typical, and maximum render CPU", async () => {
		const maximum = Array.from({ length: 100 }, (_, index) => ({
			_type: "quote",
			_version: 1,
			_key: `maximum-${index}`,
			text: `Quote ${index}`,
		}));
		const cases = { empty: [], typical, maximum };
		const cold: Record<string, number> = {};
		const timings: Record<string, number> = {};
		for (const [name, value] of Object.entries(cases)) {
			const coldStart = performance.now();
			await render(value);
			cold[name] = Number((performance.now() - coldStart).toFixed(2));
			const start = performance.now();
			for (let iteration = 0; iteration < 20; iteration++) {
				// oxlint-disable-next-line no-await-in-loop -- serial renders measure per-request CPU
				await render(value);
			}
			timings[name] = Number(((performance.now() - start) / 20).toFixed(2));
		}
		console.info("BLOCKS_RENDER_MS", JSON.stringify({ cold, warm: timings }));
		expect(cold.maximum).toBeGreaterThan(0);
		expect(timings.maximum).toBeGreaterThan(0);
	});
});
