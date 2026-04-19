import { describe, it, expect, beforeEach } from "vitest";

import type { CollectionWithFields, Field } from "../../../src/schema/types.js";
import {
	generateZodSchema,
	generateFieldSchema,
	validateContent,
	generateTypeScript,
	clearSchemaCache,
} from "../../../src/schema/zod-generator.js";

describe("Zod Generator", () => {
	beforeEach(() => {
		clearSchemaCache();
	});

	describe("generateFieldSchema", () => {
		it("should generate string schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "title",
				label: "Title",
				type: "string",
				columnType: "TEXT",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse("Hello")).toBe("Hello");
			expect(() => schema.parse(123)).toThrow();
		});

		it("should generate number schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "price",
				label: "Price",
				type: "number",
				columnType: "REAL",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse(99.99)).toBe(99.99);
			expect(() => schema.parse("not a number")).toThrow();
		});

		it("should generate integer schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "count",
				label: "Count",
				type: "integer",
				columnType: "INTEGER",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse(42)).toBe(42);
			expect(() => schema.parse(3.14)).toThrow();
		});

		it("should generate boolean schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "active",
				label: "Active",
				type: "boolean",
				columnType: "INTEGER",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse(true)).toBe(true);
			expect(schema.parse(false)).toBe(false);
			expect(() => schema.parse("yes")).toThrow();
		});

		it("should generate url schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "website",
				label: "Website",
				type: "url",
				columnType: "TEXT",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse("https://example.com")).toBe("https://example.com");
			expect(schema.parse("http://localhost:3000/path")).toBe("http://localhost:3000/path");
			expect(() => schema.parse("not-a-url")).toThrow();
			expect(() => schema.parse(123)).toThrow();
		});

		it("should generate select schema with options", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "status",
				label: "Status",
				type: "select",
				columnType: "TEXT",
				required: true,
				unique: false,
				validation: { options: ["draft", "published", "archived"] },
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse("draft")).toBe("draft");
			expect(() => schema.parse("invalid")).toThrow();
		});

		it("should generate multiSelect schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "tags",
				label: "Tags",
				type: "multiSelect",
				columnType: "JSON",
				required: true,
				unique: false,
				validation: { options: ["news", "featured", "popular"] },
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse(["news", "featured"])).toEqual(["news", "featured"]);
			expect(() => schema.parse(["invalid"])).toThrow();
		});

		it("should generate portableText schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "content",
				label: "Content",
				type: "portableText",
				columnType: "JSON",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			const validContent = [{ _type: "block", _key: "abc", style: "normal" }];
			expect(schema.parse(validContent)).toEqual(validContent);
		});

		it("should generate image schema", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "image",
				label: "Image",
				type: "image",
				columnType: "TEXT",
				required: true,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			const validImage = { id: "img123", alt: "A photo" };
			expect(schema.parse(validImage)).toMatchObject(validImage);
		});

		it("should make field optional when required is false", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
				columnType: "TEXT",
				required: false,
				unique: false,
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse(undefined)).toBe(undefined);
			expect(schema.parse("Hello")).toBe("Hello");
		});

		it("should apply default value", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "status",
				label: "Status",
				type: "string",
				columnType: "TEXT",
				required: false,
				unique: false,
				defaultValue: "draft",
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(schema.parse(undefined)).toBe("draft");
		});

		it("should apply string validation rules", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "title",
				label: "Title",
				type: "string",
				columnType: "TEXT",
				required: true,
				unique: false,
				validation: { minLength: 3, maxLength: 100 },
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(() => schema.parse("ab")).toThrow();
			expect(schema.parse("abc")).toBe("abc");
		});

		it("should apply number validation rules", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "price",
				label: "Price",
				type: "number",
				columnType: "REAL",
				required: true,
				unique: false,
				validation: { min: 0, max: 1000 },
				sortOrder: 0,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			expect(() => schema.parse(-1)).toThrow();
			expect(() => schema.parse(1001)).toThrow();
			expect(schema.parse(500)).toBe(500);
		});
	});

	describe("generateZodSchema", () => {
		it("should generate schema for collection with multiple fields", () => {
			const collection: CollectionWithFields = {
				id: "c1",
				slug: "posts",
				label: "Posts",
				supports: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				fields: [
					{
						id: "f1",
						collectionId: "c1",
						slug: "title",
						label: "Title",
						type: "string",
						columnType: "TEXT",
						required: true,
						unique: false,
						sortOrder: 0,
						createdAt: new Date().toISOString(),
					},
					{
						id: "f2",
						collectionId: "c1",
						slug: "content",
						label: "Content",
						type: "portableText",
						columnType: "JSON",
						required: true,
						unique: false,
						sortOrder: 1,
						createdAt: new Date().toISOString(),
					},
					{
						id: "f3",
						collectionId: "c1",
						slug: "views",
						label: "Views",
						type: "integer",
						columnType: "INTEGER",
						required: false,
						unique: false,
						defaultValue: 0,
						sortOrder: 2,
						createdAt: new Date().toISOString(),
					},
				],
			};

			const schema = generateZodSchema(collection);

			const validData = {
				title: "Hello World",
				content: [{ _type: "block", _key: "abc" }],
			};

			const result = schema.parse(validData);
			expect(result.title).toBe("Hello World");
			expect(result.views).toBe(0); // default applied
		});
	});

	describe("validateContent", () => {
		const collection: CollectionWithFields = {
			id: "c1",
			slug: "products",
			label: "Products",
			supports: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			fields: [
				{
					id: "f1",
					collectionId: "c1",
					slug: "name",
					label: "Name",
					type: "string",
					columnType: "TEXT",
					required: true,
					unique: false,
					validation: { minLength: 1 },
					sortOrder: 0,
					createdAt: new Date().toISOString(),
				},
				{
					id: "f2",
					collectionId: "c1",
					slug: "price",
					label: "Price",
					type: "number",
					columnType: "REAL",
					required: true,
					unique: false,
					validation: { min: 0 },
					sortOrder: 1,
					createdAt: new Date().toISOString(),
				},
			],
		};

		it("should return success for valid data", () => {
			const result = validateContent(collection, {
				name: "Widget",
				price: 29.99,
			});

			expect(result.success).toBe(true);
		});

		it("should return errors for invalid data", () => {
			const result = validateContent(collection, {
				name: "",
				price: -10,
			});

			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.errors.issues.length).toBeGreaterThan(0);
			}
		});
	});

	describe("generateTypeScript", () => {
		it("should generate TypeScript interface", () => {
			const collection: CollectionWithFields = {
				id: "c1",
				slug: "blog_posts",
				label: "Blog Posts",
				supports: ["drafts"],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				fields: [
					{
						id: "f1",
						collectionId: "c1",
						slug: "title",
						label: "Title",
						type: "string",
						columnType: "TEXT",
						required: true,
						unique: false,
						sortOrder: 0,
						createdAt: new Date().toISOString(),
					},
					{
						id: "f2",
						collectionId: "c1",
						slug: "content",
						label: "Content",
						type: "portableText",
						columnType: "JSON",
						required: true,
						unique: false,
						sortOrder: 1,
						createdAt: new Date().toISOString(),
					},
					{
						id: "f3",
						collectionId: "c1",
						slug: "featured",
						label: "Featured",
						type: "boolean",
						columnType: "INTEGER",
						required: false,
						unique: false,
						sortOrder: 2,
						createdAt: new Date().toISOString(),
					},
					{
						id: "f4",
						collectionId: "c1",
						slug: "status",
						label: "Status",
						type: "select",
						columnType: "TEXT",
						required: true,
						unique: false,
						validation: { options: ["draft", "published"] },
						sortOrder: 3,
						createdAt: new Date().toISOString(),
					},
				],
			};

			const ts = generateTypeScript(collection);

			expect(ts).toContain("export interface BlogPost");
			expect(ts).toContain("title: string;");
			expect(ts).toContain("content: PortableTextBlock[];");
			expect(ts).toContain("featured?: boolean;");
			expect(ts).toContain('status: "draft" | "published";');
		});
	});
});
