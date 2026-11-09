import { describe, expect, it } from "vitest";

import { type BlockElement, createBlockScanner } from "../src/block-elements.js";

function scanAll(html: string): BlockElement[] {
	const next = createBlockScanner(html);
	const elements: BlockElement[] = [];
	for (let element = next(0); element; element = next(element.index + element.html.length)) {
		elements.push(element);
	}
	return elements;
}

describe("createBlockScanner", () => {
	it("finds block elements in order, each up to its end tag", () => {
		const html =
			'<p>One</p>\n<h2 class="title">Two</h2><hr><img src="a.jpg" alt="A > B"><ul><li>Three</li></ul>';

		expect(scanAll(html).map(({ tag, content }) => [tag, content])).toEqual([
			["p", "One"],
			["h2", "Two"],
			["hr", ""],
			["", ""],
			["ul", "<li>Three</li>"],
		]);
	});

	it("starts a later scan where it is asked to", () => {
		const html = "<p>One</p><p>Two</p><p>Three</p>";
		const next = createBlockScanner(html);

		expect(next(0)?.content).toBe("One");
		expect(next(html.indexOf("<p>Three"))?.content).toBe("Three");
	});

	it.each([
		["repeated paragraph start tags without a closing bracket", "<p ".repeat(100_000)],
		["paragraphs without end tags", `<p>${"<p>a".repeat(100_000)}`],
		["an image tag with a long run of tabs", `<img${"\t".repeat(100_000)}`],
	])("scans %s within a second", (_shape, html) => {
		const start = process.cpuUsage();
		const elements = scanAll(html);
		const { user, system } = process.cpuUsage(start);

		expect((user + system) / 1000).toBeLessThan(1000);
		expect(elements).toEqual([]);
	});
});
