import { describe, it, expect } from "vitest";
import { deepMerge, mergeSeeds } from "../../../src/seed/merge.js";
import type { SeedFile } from "../../../src/seed/types.js";

describe("seed/merge", () => {
	describe("deepMerge", () => {
		it("concatenates arrays", () => {
			const target = [1, 2];
			const source = [3, 4];
			expect(deepMerge(target, source)).toEqual([1, 2, 3, 4]);
		});

		it("recursively merges objects", () => {
			const target = { a: 1, b: { c: 2 } };
			const source = { b: { d: 3 }, e: 4 };
			expect(deepMerge(target, source)).toEqual({ a: 1, b: { c: 2, d: 3 }, e: 4 });
		});

		it("overwrites non-object properties", () => {
			const target = { a: 1 };
			const source = { a: 2 };
			expect(deepMerge(target, source)).toEqual({ a: 2 });
		});

		it("handles null values", () => {
			const target = { a: 1 };
			const source = { a: null };
			expect(deepMerge(target, source)).toEqual({ a: null });
		});
	});

	describe("mergeSeeds", () => {
		it("merges multiple seed files correctly", () => {
			const seed1: SeedFile = {
				version: "1",
				collections: [
					{ slug: "posts", label: "Posts", fields: [] }
				],
				content: {
					posts: [{ id: "1", slug: "post-1", data: {} }]
				}
			};

			const seed2: SeedFile = {
				version: "1",
				collections: [
					{ slug: "pages", label: "Pages", fields: [] }
				],
				content: {
					posts: [{ id: "2", slug: "post-2", data: {} }],
					pages: [{ id: "1", slug: "page-1", data: {} }]
				}
			};

			const merged = mergeSeeds([seed1, seed2]);
			
			expect(merged.version).toBe("1");
			expect(merged.collections).toHaveLength(2);
			expect(merged.collections![0].slug).toBe("posts");
			expect(merged.collections![1].slug).toBe("pages");
			
			expect(Object.keys(merged.content!)).toEqual(["posts", "pages"]);
			expect(merged.content!.posts).toHaveLength(2);
			expect(merged.content!.pages).toHaveLength(1);
		});
	});
});
