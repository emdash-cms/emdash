/**
 * Tests for WordPress import prepare schema validation
 *
 * Regression test for #167: wpPrepareBody schema defined fields as z.record()
 * but all producers (analyzer, admin UI) send an array of ImportFieldDef.
 */

import { describe, expect, it } from "vitest";

import { wpPrepareBody } from "../../../src/api/schemas/import.js";

describe("wpPrepareBody schema", () => {
	it("accepts fields as an array of ImportFieldDef objects", () => {
		const input = {
			postTypes: [
				{
					name: "post",
					collection: "posts",
					fields: [
						{
							slug: "content",
							label: "Content",
							type: "portableText",
							required: true,
							searchable: true,
						},
						{
							slug: "excerpt",
							label: "Excerpt",
							type: "text",
							required: false,
						},
					],
				},
			],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(true);
	});

	it("accepts fields with optional searchable property", () => {
		const input = {
			postTypes: [
				{
					name: "page",
					collection: "pages",
					fields: [
						{
							slug: "featured_image",
							label: "Featured Image",
							type: "image",
							required: false,
						},
					],
				},
			],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(true);
	});

	it("accepts postTypes without fields (optional)", () => {
		const input = {
			postTypes: [
				{
					name: "post",
					collection: "posts",
				},
			],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(true);
	});

	it("rejects fields with missing required properties", () => {
		const input = {
			postTypes: [
				{
					name: "post",
					collection: "posts",
					fields: [
						{
							slug: "content",
							// missing label, type, required
						},
					],
				},
			],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(false);
	});

	it("accepts multiple postTypes with fields", () => {
		const input = {
			postTypes: [
				{
					name: "post",
					collection: "posts",
					fields: [
						{
							slug: "content",
							label: "Content",
							type: "portableText",
							required: true,
							searchable: true,
						},
					],
				},
				{
					name: "page",
					collection: "pages",
					fields: [
						{
							slug: "content",
							label: "Content",
							type: "portableText",
							required: true,
							searchable: true,
						},
						{
							slug: "featured_image",
							label: "Featured Image",
							type: "image",
							required: false,
						},
					],
				},
			],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(true);
	});

	it("normalizes analyze-shaped post types to the prepare shape", () => {
		const input = {
			postTypes: [
				{
					name: "post",
					suggestedCollection: "posts",
					requiredFields: [
						{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
					],
				},
			],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(true);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion
		expect(
			(result.data as { postTypes: Array<{ collection: string; fields: unknown[] }> }).postTypes[0],
		).toEqual({
			name: "post",
			collection: "posts",
			fields: [{ slug: "title", label: "Title", type: "string", required: true, searchable: true }],
		});
	});

	it("defaults missing fields to an empty array", () => {
		const input = {
			postTypes: [{ name: "post", collection: "posts" }],
		};

		const result = wpPrepareBody.safeParse(input);
		expect(result.success).toBe(true);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion
		expect(
			(result.data as { postTypes: Array<{ fields: unknown[] }> }).postTypes[0].fields,
		).toEqual([]);
	});
});
