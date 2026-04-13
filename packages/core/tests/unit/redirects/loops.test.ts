import { describe, it, expect } from "vitest";

import { detectLoops, wouldCreateLoop, type RedirectEdge } from "../../../src/redirects/loops.js";

function edge(
	id: string,
	source: string,
	destination: string,
	enabled = true,
	isPattern = false,
): RedirectEdge {
	return { id, source, destination, enabled, isPattern };
}

describe("detectLoops", () => {
	it("detects a simple 2-node loop", () => {
		const edges = [edge("1", "/a", "/b"), edge("2", "/b", "/a")];
		const result = detectLoops(edges);
		expect(result).toContain("1");
		expect(result).toContain("2");
	});

	it("detects a 3-node loop", () => {
		const edges = [
			edge("1", "/one", "/two"),
			edge("2", "/two", "/three"),
			edge("3", "/three", "/one"),
		];
		const result = detectLoops(edges);
		expect(result).toHaveLength(3);
	});

	it("returns no loops for a clean chain", () => {
		const edges = [edge("1", "/a", "/b"), edge("2", "/b", "/c")];
		const result = detectLoops(edges);
		expect(result).toHaveLength(0);
	});

	it("ignores disabled redirects", () => {
		const edges = [edge("1", "/a", "/b", true), edge("2", "/b", "/a", false)];
		const result = detectLoops(edges);
		expect(result).toHaveLength(0);
	});

	it("detects loop when exact redirect destination matches a pattern source", () => {
		const edges = [
			edge("1", "/blog/[slug]", "/articles/[slug]", true, true),
			edge("2", "/articles/test", "/blog/test"),
		];
		const result = detectLoops(edges);
		expect(result).toContain("1");
		expect(result).toContain("2");
	});

	it("detects loops in pattern redirects with matching templates", () => {
		const edges = [
			edge("1", "/blog/[slug]", "/articles/[slug]", true, true),
			edge("2", "/articles/[slug]", "/blog/[slug]", true, true),
		];
		const result = detectLoops(edges);
		expect(result).toContain("1");
		expect(result).toContain("2");
	});

	it("detects loops between pattern and exact redirects", () => {
		const edges = [
			edge("1", "/blog/[slug]", "/articles/[slug]", true, true),
			edge("2", "/articles/hello", "/blog/hello"),
		];
		const result = detectLoops(edges);
		expect(result).toContain("1");
		expect(result).toContain("2");
	});

	it("detects multiple independent loops", () => {
		const edges = [
			edge("1", "/a", "/b"),
			edge("2", "/b", "/a"),
			edge("3", "/x", "/y"),
			edge("4", "/y", "/x"),
		];
		const result = detectLoops(edges);
		expect(result).toHaveLength(4);
	});

	it("returns empty array for no redirects", () => {
		const result = detectLoops([]);
		expect(result).toHaveLength(0);
	});
});

describe("wouldCreateLoop", () => {
	it("returns null for a safe redirect", () => {
		const edges = [edge("1", "/a", "/b")];
		const result = wouldCreateLoop("/c", "/d", edges);
		expect(result).toBeNull();
	});

	it("detects a direct loop", () => {
		const edges = [edge("1", "/b", "/a")];
		const result = wouldCreateLoop("/a", "/b", edges);
		expect(result).not.toBeNull();
		expect(result).toEqual(["/a", "/b", "/a"]);
	});

	it("detects a loop through an existing chain", () => {
		const edges = [edge("1", "/one", "/two"), edge("2", "/two", "/three")];
		// Adding /three → /one would create: /three → /one → /two → /three
		const result = wouldCreateLoop("/three", "/one", edges);
		expect(result).not.toBeNull();
		expect(result!.at(-1)).toBe("/three");
	});

	it("excludes the redirect being updated", () => {
		const edges = [edge("1", "/a", "/b"), edge("2", "/b", "/c")];
		// Updating redirect "1" to /a → /c, exclude "1" from the graph
		const result = wouldCreateLoop("/a", "/c", edges, "1");
		expect(result).toBeNull();
	});

	it("detects loop even when updating", () => {
		const edges = [edge("1", "/a", "/b"), edge("2", "/b", "/c"), edge("3", "/c", "/d")];
		// Updating "3" to /c → /a would create: /c → /a → /b → /c
		const result = wouldCreateLoop("/c", "/a", edges, "3");
		expect(result).not.toBeNull();
	});

	it("returns null when destination has no further redirects", () => {
		const edges = [edge("1", "/a", "/b")];
		const result = wouldCreateLoop("/x", "/y", edges);
		expect(result).toBeNull();
	});

	it("detects loop when exact destination matches a pattern source", () => {
		const edges = [edge("1", "/blog/[slug]", "/articles/[slug]", true, true)];
		// Adding /articles/hello → /blog/hello would loop via the pattern:
		// /articles/hello → /blog/hello → (matches /blog/[slug]) → /articles/hello
		const result = wouldCreateLoop("/articles/hello", "/blog/hello", edges);
		expect(result).not.toBeNull();
		expect(result).toEqual(["/articles/hello", "/blog/hello", "/articles/hello"]);
	});

	it("detects loop when pattern source redirect destination resolves back to itself", () => {
		// /blog/[slug] → /articles/[slug] exists
		// Adding /articles/[slug] → /blog/hello:
		// walk: /blog/hello → matches /blog/[slug] → /articles/hello → matches /articles/[slug] (proposed source)
		const edges = [edge("1", "/blog/[slug]", "/articles/[slug]", true, true)];
		const result = wouldCreateLoop("/articles/[slug]", "/blog/hello", edges);
		expect(result).not.toBeNull();
	});

	it("detects loop between catch-all [...path] and [slug] patterns via representatives", () => {
		// /old/[...path] → /new/[...path] exists
		// Adding /new/archive/[slug] → /old/archive/[slug]:
		// representative /old/archive/__p__ matches /old/[...path] → /new/archive/__p__
		// /new/archive/__p__ matches proposed source /new/archive/[slug] → loop
		const edges = [edge("1", "/old/[...path]", "/new/[...path]", true, true)];
		const result = wouldCreateLoop("/new/archive/[slug]", "/old/archive/[slug]", edges);
		expect(result).not.toBeNull();
	});

	it("detects loop with multiple overlapping patterns and exact redirects", () => {
		// Complex setup:
		// /blog/[slug] → /articles/[slug]
		// /blogs/[slug] → /articles/[slug]
		// /articles/[slug] → /news/[slug]
		// /blogs/hi → /news/hi (exact, shadows /blogs/[slug] for this path)
		// /blog/hello → /articles/hello (exact, shadows /blog/[slug] for this path)
		//
		// Adding /news/[slug] → /blog/[slug] closes the loop:
		// /blog/[slug] → /articles/[slug] → /news/[slug] → /blog/[slug]
		const edges = [
			edge("1", "/blog/[slug]", "/articles/[slug]", true, true),
			edge("2", "/blogs/[slug]", "/articles/[slug]", true, true),
			edge("3", "/articles/[slug]", "/news/[slug]", true, true),
			edge("4", "/blogs/hi", "/news/hi"),
			edge("5", "/blog/hello", "/articles/hello"),
		];
		const result = wouldCreateLoop("/news/[slug]", "/blog/[slug]", edges);
		expect(result).not.toBeNull();
	});

	it("exact redirects coexisting with patterns do not prevent loop detection", () => {
		// Even though /blog/hello has an exact redirect, the pattern /blog/[slug]
		// still loops for all other slugs. The loop must be detected.
		const edges = [
			edge("1", "/blog/[slug]", "/articles/[slug]", true, true),
			edge("2", "/articles/[slug]", "/news/[slug]", true, true),
			edge("3", "/blog/hello", "/articles/hello"),
		];
		const result = wouldCreateLoop("/news/[slug]", "/blog/[slug]", edges);
		expect(result).not.toBeNull();
	});
});
