/**
 * `Comments`/`CommentForm` used to live in the same barrel
 * (`components/index.ts`) as `PortableText` and the block-type components.
 * Astro's CSS module-graph scanner pulls in every `<style>` reachable from
 * an imported module regardless of which named export a page actually
 * uses, so any site importing `PortableText` from `emdash/ui` got
 * Comments/CommentForm's CSS bundled into a shared, render-blocking chunk
 * even when comments were never rendered. Fixed by moving Comments/
 * CommentForm into their own module, re-exported from `emdash/ui`
 * separately so the two stay on different static import paths.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSrc(relativePath: string): string {
	return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf-8");
}

describe("emdash/ui — Comments/CommentForm CSS isolation", () => {
	it("keeps the PortableText/blocks barrel free of Comments/CommentForm", () => {
		const barrel = readSrc("../../../src/components/index.ts");
		expect(barrel).not.toMatch(/["']\.\/(Comments|CommentForm)\.astro["']/);
	});

	it("still exports Comments and CommentForm from emdash/ui, via a separate module", () => {
		const ui = readSrc("../../../src/ui.ts");
		const commentsExport = ui.match(
			/export\s*\{\s*Comments,\s*CommentForm\s*\}\s*from\s*"([^"]+)"/,
		);
		expect(commentsExport).not.toBeNull();
		expect(commentsExport?.[1]).not.toBe("./components/index.js");
	});

	it("the separate Comments module only re-exports Comments/CommentForm", () => {
		const comments = readSrc("../../../src/components/comments.ts");
		expect(comments).toMatch(/["']\.\/Comments\.astro["']/);
		expect(comments).toMatch(/["']\.\/CommentForm\.astro["']/);
		expect(comments).not.toMatch(/PortableText\.astro/);
	});
});
