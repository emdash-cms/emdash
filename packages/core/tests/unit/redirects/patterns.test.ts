import { describe, it, expect } from "vitest";

import {
	isPattern,
	validatePattern,
	validateDestinationParams,
	compilePattern,
	matchPattern,
	interpolateDestination,
} from "../../../src/redirects/patterns.js";

describe("redirect patterns", () => {
	describe("isPattern", () => {
		it("returns true for [param] patterns", () => {
			expect(isPattern("/blog/[slug]")).toBe(true);
		});

		it("returns true for [...rest] patterns", () => {
			expect(isPattern("/old/[...path]")).toBe(true);
		});

		it("returns false for literal paths", () => {
			expect(isPattern("/about")).toBe(false);
			expect(isPattern("/blog/my-post")).toBe(false);
		});

		it("returns false for empty string", () => {
			expect(isPattern("")).toBe(false);
		});
	});

	describe("validatePattern", () => {
		it("accepts valid patterns", () => {
			expect(validatePattern("/blog/[slug]")).toBeNull();
			expect(validatePattern("/[category]/[slug]")).toBeNull();
			expect(validatePattern("/old/[...path]")).toBeNull();
			expect(validatePattern("/about")).toBeNull();
		});

		it("rejects patterns not starting with /", () => {
			expect(validatePattern("blog/[slug]")).toBe("Pattern must start with /");
		});

		it("rejects nested brackets", () => {
			expect(validatePattern("/blog/[[slug]]")).toBe("Nested brackets are not allowed");
		});

		it("rejects empty brackets", () => {
			expect(validatePattern("/blog/[]")).toBe("Empty brackets are not allowed");
		});

		it("rejects unmatched brackets", () => {
			expect(validatePattern("/blog/[slug")).toBe("Unmatched brackets");
			expect(validatePattern("/blog/slug]")).toBe("Unmatched brackets");
		});

		it("rejects [...splat] not in last segment", () => {
			expect(validatePattern("/[...path]/extra")).toBe(
				"Catch-all [...param] must be in the last segment",
			);
		});

		it("allows [...splat] in last segment", () => {
			expect(validatePattern("/prefix/[...path]")).toBeNull();
		});

		it("rejects multiple placeholders per segment", () => {
			expect(validatePattern("/[a][b]")).toBe("Each segment can contain at most one placeholder");
		});

		it("rejects mixed literal and placeholder in segment", () => {
			expect(validatePattern("/pre-[slug]")).toBe(
				"A placeholder must be the entire segment, not mixed with literal text",
			);
		});

		it("rejects duplicate parameter names", () => {
			expect(validatePattern("/[slug]/[slug]")).toBe("Duplicate parameter name: slug");
		});

		it("validates consecutively without regex state leaking", () => {
			// Calling validatePattern multiple times should not have stateful regex issues
			expect(validatePattern("/[a]")).toBeNull();
			expect(validatePattern("/[b]")).toBeNull();
			expect(validatePattern("/[c]/[...rest]")).toBeNull();
		});
	});

	describe("validateDestinationParams", () => {
		it("returns null when destination params are subset of source", () => {
			expect(validateDestinationParams("/[slug]", "/new/[slug]")).toBeNull();
			expect(validateDestinationParams("/[category]/[slug]", "/[category]/[slug]")).toBeNull();
		});

		it("returns null for destinations with no placeholders", () => {
			expect(validateDestinationParams("/[slug]", "/fixed-path")).toBeNull();
		});

		it("returns error for unknown destination param", () => {
			expect(validateDestinationParams("/[slug]", "/[category]/[slug]")).toBe(
				"Destination references [category] which is not captured in the source pattern",
			);
		});

		it("allows [...rest] params in destination when in source", () => {
			expect(validateDestinationParams("/old/[...path]", "/new/[...path]")).toBeNull();
		});
	});

	describe("compilePattern", () => {
		it("compiles [param] to single-segment capture", () => {
			const compiled = compilePattern("/blog/[slug]");
			expect(compiled.paramNames).toEqual(["slug"]);
			expect(compiled.source).toBe("/blog/[slug]");
			expect(compiled.regex.test("/blog/my-post")).toBe(true);
			expect(compiled.regex.test("/blog/")).toBe(false);
			expect(compiled.regex.test("/blog/a/b")).toBe(false);
		});

		it("compiles [...rest] to multi-segment capture", () => {
			const compiled = compilePattern("/old/[...path]");
			expect(compiled.paramNames).toEqual(["path"]);
			expect(compiled.regex.test("/old/a")).toBe(true);
			expect(compiled.regex.test("/old/a/b/c")).toBe(true);
			expect(compiled.regex.test("/old/")).toBe(false);
		});

		it("compiles multiple params", () => {
			const compiled = compilePattern("/[category]/[slug]");
			expect(compiled.paramNames).toEqual(["category", "slug"]);
			expect(compiled.regex.test("/tech/my-post")).toBe(true);
			expect(compiled.regex.test("/tech/")).toBe(false);
		});

		it("compiles literal-only paths", () => {
			const compiled = compilePattern("/about/team");
			expect(compiled.paramNames).toEqual([]);
			expect(compiled.regex.test("/about/team")).toBe(true);
			expect(compiled.regex.test("/about/other")).toBe(false);
		});

		it("escapes regex-special characters in literal parts", () => {
			const compiled = compilePattern("/blog.old/[slug]");
			// The dot should be escaped, not matching any character
			expect(compiled.regex.test("/blog.old/test")).toBe(true);
			expect(compiled.regex.test("/blogXold/test")).toBe(false);
		});

		it("treats parentheses in literal parts as literal characters", () => {
			const compiled = compilePattern("/(.*x)/[slug]");
			expect(matchPattern(compiled, "/(.*x)/hello")).toEqual({ slug: "hello" });
			expect(compiled.regex.test("/abcx/hello")).toBe(false);

			const grouped = compilePattern("/foo(bar)/[slug]");
			expect(matchPattern(grouped, "/foo(bar)/hello")).toEqual({ slug: "hello" });
			expect(grouped.regex.test("/foobar/hello")).toBe(false);
		});

		it("assigns captures to the right names when a [param] precedes a [...splat]", () => {
			const compiled = compilePattern("/[category]/[...rest]");
			expect(matchPattern(compiled, "/tech/a/b")).toEqual({ category: "tech", rest: "a/b" });
		});

		it("compiles a source with unbalanced literal parentheses", () => {
			const compiled = compilePattern("/a((b)/[slug]");
			expect(matchPattern(compiled, "/a((b)/hello")).toEqual({ slug: "hello" });
		});
	});

	describe("matchPattern", () => {
		it("captures [param] values", () => {
			const compiled = compilePattern("/blog/[slug]");
			expect(matchPattern(compiled, "/blog/my-post")).toEqual({ slug: "my-post" });
		});

		it("captures [...rest] values", () => {
			const compiled = compilePattern("/old/[...path]");
			expect(matchPattern(compiled, "/old/2024/01/post")).toEqual({
				path: "2024/01/post",
			});
		});

		it("captures multiple params", () => {
			const compiled = compilePattern("/[category]/[slug]");
			expect(matchPattern(compiled, "/tech/my-post")).toEqual({
				category: "tech",
				slug: "my-post",
			});
		});

		it("returns null on no match", () => {
			const compiled = compilePattern("/blog/[slug]");
			expect(matchPattern(compiled, "/about")).toBeNull();
			expect(matchPattern(compiled, "/blog/a/b")).toBeNull();
		});

		it("returns empty object for literal paths", () => {
			const compiled = compilePattern("/about/team");
			expect(matchPattern(compiled, "/about/team")).toEqual({});
		});

		it("handles URL-encoded segments", () => {
			const compiled = compilePattern("/blog/[slug]");
			expect(matchPattern(compiled, "/blog/my%20post")).toEqual({ slug: "my%20post" });
		});
	});

	describe("interpolateDestination", () => {
		it("replaces [param] with captured values", () => {
			expect(interpolateDestination("/new/[slug]", { slug: "my-post" })).toBe("/new/my-post");
		});

		it("replaces [...rest] with captured values", () => {
			expect(interpolateDestination("/new/[...path]", { path: "2024/01/post" })).toBe(
				"/new/2024/01/post",
			);
		});

		it("replaces multiple params", () => {
			expect(
				interpolateDestination("/[category]/posts/[slug]", {
					category: "tech",
					slug: "my-post",
				}),
			).toBe("/tech/posts/my-post");
		});

		it("replaces missing params with empty string", () => {
			expect(interpolateDestination("/[slug]", {})).toBe("/");
		});

		it("leaves literal destinations unchanged", () => {
			expect(interpolateDestination("/about", {})).toBe("/about");
		});
	});

	describe("end-to-end: compile + match + interpolate", () => {
		it("handles blog migration pattern", () => {
			const source = compilePattern("/old-blog/[...path]");
			const params = matchPattern(source, "/old-blog/2024/01/my-great-post");
			expect(params).toEqual({ path: "2024/01/my-great-post" });

			const destination = interpolateDestination("/blog/[...path]", params!);
			expect(destination).toBe("/blog/2024/01/my-great-post");
		});

		it("handles category restructure pattern", () => {
			const source = compilePattern("/articles/[category]/[slug]");
			const params = matchPattern(source, "/articles/tech/typescript-tips");
			expect(params).toEqual({ category: "tech", slug: "typescript-tips" });

			const destination = interpolateDestination("/blog/[category]/[slug]", params!);
			expect(destination).toBe("/blog/tech/typescript-tips");
		});

		it("handles pattern with params dropped in destination", () => {
			const source = compilePattern("/v1/[category]/[slug]");
			const params = matchPattern(source, "/v1/news/hello");
			expect(params).toEqual({ category: "news", slug: "hello" });

			// Destination only uses slug, drops category
			const destination = interpolateDestination("/posts/[slug]", params!);
			expect(destination).toBe("/posts/hello");
		});
	});
});
