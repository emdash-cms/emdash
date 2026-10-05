import { describe, expect, it } from "vitest";

import { insertBeforeBodyEnd } from "../../src/db/insert-before-body-end.js";

// Astro escapes only `&` and `"` in attribute values, so this alt text reaches
// the page as written.
const IMAGE = '<img alt="</body><img src=x onerror=alert(1)>">';

describe("insertBeforeBodyEnd", () => {
	it("inserts before the page's closing body tag, not into an attribute", () => {
		const content = `<!DOCTYPE html><html><body>${IMAGE}<p>Post</p>`;
		// A script the page renders after its layout ends up after `</html>`.
		const end = "</body></html><script>1</script>";

		expect(insertBeforeBodyEnd(content + end, "<div>Toolbar</div>")).toBe(
			`${content}<div>Toolbar</div>${end}`,
		);
	});

	it("leaves anything but a whole document alone", () => {
		expect(insertBeforeBodyEnd("<p>Fragment</p>", "<div>Toolbar</div>")).toBeUndefined();
		// A server island's HTML, whose only `</body>` is author text.
		expect(insertBeforeBodyEnd(`${IMAGE}<p>Island</p>`, "<div>Toolbar</div>")).toBeUndefined();
	});
});
