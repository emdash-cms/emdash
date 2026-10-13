import { describe, expect, it } from "vitest";

import { liftPastedBlocks } from "../../src/components/editor/liftPastedBlocks";

describe("liftPastedBlocks", () => {
	it("numbers a nested list moved out of a split item from the start", () => {
		const html =
			"<ol><li><p>a</p><ol><li><p>x</p></li><li><h3>H</h3><p>y</p></li><li><p>z</p></li></ol></li><li><p>b</p></li></ol>";

		expect(liftPastedBlocks(html)).toBe(
			'<ol><li><p>a</p><ol><li><p>x</p></li></ol></li></ol><h3>H</h3><ol><li><p>y</p></li><li><p>z</p></li></ol><ol start="2"><li><p>b</p></li></ol>',
		);
	});
});
