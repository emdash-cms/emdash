import tsc from "typescript";
import { describe, it, expect, beforeEach } from "vitest";

import type { CollectionWithFields, Field, RepeaterSubField } from "../../../src/schema/types.js";
import { REPEATER_SUB_FIELD_TYPES } from "../../../src/schema/types.js";
import {
	generateZodSchema,
	generateFieldSchema,
	validateContent,
	generateTypeScript,
	generateTypesFile,
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

		it("should coerce stored 0/1 booleans to real booleans", () => {
			// Boolean fields map to `INTEGER` columns (`FIELD_TYPE_TO_COLUMN`
			// in `schema/types.ts`) and `serializeValue` in
			// `database/repositories/content.ts` writes booleans as 0/1.
			// `deserializeValue` never converts them back, so a GET → POST
			// round-trip on a boolean field fails validation (`z.boolean()`
			// rejects numbers) unless this schema accepts the integer shape.
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
			expect(schema.parse(0)).toBe(false);
			expect(schema.parse(1)).toBe(true);
			// Other numbers must still fail — only the integer 0/1 shape is accepted.
			expect(() => schema.parse(2)).toThrow();
			expect(() => schema.parse(-1)).toThrow();
			// Strings still fail.
			expect(() => schema.parse("0")).toThrow();
			expect(() => schema.parse("true")).toThrow();
			// BigInt from drivers that return 64-bit ints is unsupported (no
			// known driver currently does this for boolean columns); rejecting
			// is safer than a silent coercion that could hide a real bug.
			expect(() => schema.parse(BigInt(0))).toThrow();
		});

		it("should preserve `.default(false)` chaining through the boolean preprocess", () => {
			const field: Field = {
				id: "f1",
				collectionId: "c1",
				slug: "active",
				label: "Active",
				type: "boolean",
				columnType: "INTEGER",
				required: false,
				unique: false,
				sortOrder: 0,
				defaultValue: false,
				createdAt: new Date().toISOString(),
			};

			const schema = generateFieldSchema(field);
			// default applies when the value is undefined.
			expect(schema.parse(undefined)).toBe(false);
			// Stored integer shape still coerces.
			expect(schema.parse(1)).toBe(true);
		});

		it("should accept stored 0/1 booleans in partial-mode validation", () => {
			// `validateContentData` in `api/handlers/validation.ts` calls
			// `schema.partial()` for updates. Confirm that partial mode keeps
			// the preprocess intact for the boolean field.
			const collection: CollectionWithFields = {
				id: "c1",
				slug: "posts",
				labelPlural: "Posts",
				labelSingular: "Post",
				updatedAt: new Date().toISOString(),
				fields: [
					{
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
					},
				],
			};

			const schema = generateZodSchema(collection).partial();
			expect(schema.parse({ active: 0 })).toEqual({ active: false });
			expect(schema.parse({ active: 1 })).toEqual({ active: true });
			expect(schema.parse({})).toEqual({});
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
			const validImage = {
				id: "img123",
				provider: "local",
				filename: "photo.webp",
				mimeType: "image/webp",
				alt: "A photo",
				width: 1200,
				height: 800,
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
				dominantColor: "#d9d2c5",
				meta: { storageKey: "photo.webp" },
			};
			expect(schema.parse(validImage)).toEqual(validImage);
		});

		it("accepts a dark variant on an image field and rejects a malformed one", () => {
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
			const withVariant = {
				id: "img-light",
				provider: "local",
				darkVariant: { id: "img-dark", provider: "local", width: 1200, height: 800 },
			};
			expect(schema.parse(withVariant)).toEqual(withVariant);
			expect(
				schema.safeParse({ id: "img-light", darkVariant: { provider: "local" } }).success,
			).toBe(false);
			expect(schema.safeParse({ id: "img-light", darkVariant: "img-dark" }).success).toBe(false);
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
					{
						id: "f5",
						collectionId: "c1",
						slug: "hero",
						label: "Hero",
						type: "image",
						columnType: "TEXT",
						required: true,
						unique: false,
						sortOrder: 4,
						createdAt: new Date().toISOString(),
					},
				],
			};

			const ts = generateTypeScript(collection);

			// Interface names derive from the singularized slug
			// (`blog_posts` -> `BlogPost`), not the human label, so they are
			// always valid TS identifiers describing a single entry.
			expect(ts).toContain("export interface BlogPost");
			expect(ts).toContain("title: string;");
			expect(ts).toContain("content: PortableTextBlock[];");
			expect(ts).toContain("featured?: boolean;");
			expect(ts).toContain('status: "draft" | "published";');
			expect(ts).toContain(
				"hero: { id: string; src?: string; alt?: string; width?: number; height?: number; filename?: string; mimeType?: string; blurhash?: string; dominantColor?: string; provider?: string; previewUrl?: string; meta?: Record<string, unknown>; darkVariant?: { id: string; src?: string; alt?: string; width?: number; height?: number; filename?: string; mimeType?: string; blurhash?: string; dominantColor?: string; provider?: string; previewUrl?: string; meta?: Record<string, unknown> } };",
			);
			// Hydrated by getEmDashCollection/getEmDashEntry
			expect(ts).toContain("bylines?: ContentBylineCredit[];");
			expect(ts).toContain("terms?: Record<string, TaxonomyTerm[]>;");
		});
	});

	describe("interface names derive from the singularized slug", () => {
		// A minimal collection factory: interface naming only depends on slug/labels.
		function makeCollection(
			slug: string,
			overrides: Partial<CollectionWithFields> = {},
		): CollectionWithFields {
			return {
				id: `c_${slug}`,
				slug,
				label: slug,
				supports: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				fields: [],
				...overrides,
			};
		}

		function interfaceNamesOf(ts: string): string[] {
			return Array.from(ts.matchAll(/export interface (\S+)/g), (m) => m[1]!);
		}

		it("uses the slug, ignoring an arbitrary human label", () => {
			// The label has spaces and parentheses that are illegal in an
			// identifier; the slug (constrained `[a-z0-9_]`) is used instead.
			const ts = generateTypeScript(makeCollection("book", { labelSingular: "Book (do not use)" }));

			expect(interfaceNamesOf(ts)).toEqual(["Book"]);
		});

		it("keeps names unique when singularization collapses two slugs", () => {
			// `book` and `books` both singularize to `Book`; the collision is
			// resolved with a numeric suffix so the generated `.d.ts` never
			// declares the same identifier twice.
			const ts = generateTypesFile([makeCollection("book"), makeCollection("books")]);

			const names = interfaceNamesOf(ts);
			expect(names).toEqual(["Book", "Book2"]);
			expect(new Set(names).size).toBe(names.length);
		});

		it("keeps names unique when a suffixed name collides with another slug", () => {
			// `book` and `books` both singularize to `Book`, so `books` gets
			// suffixed to `Book2` -- which is also exactly what `book2` produces.
			// The dedupe must skip past an already-taken suffix, not blindly emit
			// it, or the file declares `Book2` twice.
			const ts = generateTypesFile([
				makeCollection("book"),
				makeCollection("books"),
				makeCollection("book2"),
			]);

			const names = interfaceNamesOf(ts);
			expect(new Set(names).size).toBe(names.length);
		});

		it("singularizes and PascalCases multi-word slugs", () => {
			expect(interfaceNamesOf(generateTypeScript(makeCollection("blog_posts")))).toEqual([
				"BlogPost",
			]);
		});

		it("singularizes a plural slug to describe a single entry", () => {
			expect(interfaceNamesOf(generateTypeScript(makeCollection("pages")))).toEqual(["Page"]);
		});

		it("leaves an already-singular slug unchanged", () => {
			expect(interfaceNamesOf(generateTypeScript(makeCollection("book")))).toEqual(["Book"]);
		});

		it("references the same interface names in the EmDashCollections map", () => {
			const ts = generateTypesFile([
				makeCollection("book", { labelSingular: "Book (do not use)" }),
				makeCollection("blog_posts"),
			]);

			// Every interface declared must be referenced by the augmentation map,
			// keyed by slug -> interface name.
			expect(ts).toContain("export interface Book {");
			expect(ts).toContain("book: Book;");
			expect(ts).toContain("export interface BlogPost {");
			expect(ts).toContain("blog_posts: BlogPost;");
		});
	});

	describe("repeater fields in generated types", () => {
		// The literal the top-level `image` case emits. An `image` sub-field must
		// emit the same shape.
		const MEDIA_LITERAL =
			"{ id: string; src?: string; alt?: string; width?: number; height?: number; filename?: string; mimeType?: string; blurhash?: string; dominantColor?: string; provider?: string; previewUrl?: string; meta?: Record<string, unknown>; darkVariant?: { id: string; src?: string; alt?: string; width?: number; height?: number; filename?: string; mimeType?: string; blurhash?: string; dominantColor?: string; provider?: string; previewUrl?: string; meta?: Record<string, unknown> } }";

		// A collection with a single `specs` repeater. Passing `undefined` omits
		// `validation` entirely, which is how a repeater with no declared rows
		// reaches the emitter.
		function makeRepeaterCollection(
			subFields: RepeaterSubField[] | undefined,
			fieldOverrides: Partial<Field> = {},
		): CollectionWithFields {
			return {
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
						slug: "specs",
						label: "Specs",
						type: "repeater",
						columnType: "JSON",
						required: false,
						unique: false,
						sortOrder: 0,
						createdAt: new Date().toISOString(),
						...(subFields ? { validation: { subFields } } : {}),
						...fieldOverrides,
					},
				],
			};
		}

		// The `specs` type node, read back out of the generated declaration file.
		function specsTypeOf(file: string): tsc.TypeNode {
			const parsed = tsc.createSourceFile("emdash-env.d.ts", file, tsc.ScriptTarget.Latest, true);
			let found: tsc.TypeNode | undefined;
			const visit = (node: tsc.Node): void => {
				if (
					tsc.isPropertySignature(node) &&
					tsc.isIdentifier(node.name) &&
					node.name.text === "specs" &&
					node.type
				) {
					found = node.type;
					return;
				}
				tsc.forEachChild(node, visit);
			};
			visit(parsed);
			if (!found) throw new Error("generated file declares no `specs` property");
			return found;
		}

		// The row literal's members, in emitted order.
		function rowMembersOf(file: string): { name: string; type: string }[] {
			const type = specsTypeOf(file);
			if (!tsc.isArrayTypeNode(type)) throw new Error("`specs` is not an array type");
			if (!tsc.isTypeLiteralNode(type.elementType)) throw new Error("row is not a type literal");
			return type.elementType.members.map((member) => {
				if (!tsc.isPropertySignature(member) || !member.type) {
					throw new Error("row member is not a property signature");
				}
				return {
					name: tsc.isStringLiteral(member.name) ? member.name.text : member.name.getText(),
					type: member.type.getText(),
				};
			});
		}

		it("builds a row object array from subFields", () => {
			const ts = generateTypeScript(
				makeRepeaterCollection([
					{ slug: "name", label: "Name", type: "text", required: true },
					{ slug: "value", label: "Value", type: "string" },
				]),
			);

			expect(ts).toContain(`specs?: { "name": string; "value"?: string | null }[];`);
		});

		it("types a sub-field that is not required as nullable", () => {
			// A sub-field that is not required may be null at runtime.
			const ts = generateTypeScript(
				makeRepeaterCollection([{ slug: "note", label: "Note", type: "string" }]),
			);

			expect(ts).toContain(`specs?: { "note"?: string | null }[];`);
		});

		it("enumerates the options of a select sub-field", () => {
			const ts = generateTypeScript(
				makeRepeaterCollection([
					{
						slug: "unit",
						label: "Unit",
						type: "select",
						required: true,
						options: ["cm", "in"],
					},
				]),
			);

			expect(ts).toContain('specs?: { "unit": "cm" | "in" }[];');
		});

		it("emits the media literal for an image sub-field", () => {
			const ts = generateTypeScript(
				makeRepeaterCollection([{ slug: "photo", label: "Photo", type: "image", required: true }]),
			);

			expect(ts).toContain(`specs?: { "photo": ${MEDIA_LITERAL} }[];`);
		});

		// Cases are driven from REPEATER_SUB_FIELD_TYPES, so a new sub-field type
		// fails here until it is mapped.
		const EXPECTED_TS_TYPE: Record<RepeaterSubField["type"], string> = {
			string: "string",
			text: "string",
			url: "string",
			number: "number",
			integer: "number",
			boolean: "boolean",
			datetime: "string",
			select: "string",
			image: MEDIA_LITERAL,
		};

		it.each([...REPEATER_SUB_FIELD_TYPES])("maps a %s sub-field", (type) => {
			const ts = generateTypeScript(
				makeRepeaterCollection([{ slug: "value", label: "Value", type, required: true }]),
			);

			expect(ts).toContain(`specs?: { "value": ${EXPECTED_TS_TYPE[type]} }[];`);
		});

		it("falls back to unknown when subFields is absent", () => {
			expect(generateTypeScript(makeRepeaterCollection(undefined))).toContain("specs?: unknown;");
		});

		it("falls back to unknown when subFields is empty", () => {
			expect(generateTypeScript(makeRepeaterCollection([]))).toContain("specs?: unknown;");
		});

		// `validation` is unvalidated JSON on the seed and registry paths, so
		// `subFields` is not necessarily an array. A string is iterable and passes a
		// length check, so it yields a bogus member rather than throwing.
		it.each([{}, "nope", 42, true, null])("falls back to unknown when subFields is %j", (bad) => {
			const collection = makeRepeaterCollection(bad as unknown as RepeaterSubField[]);

			expect(generateTypeScript(collection)).toContain("specs?: unknown;");
		});

		describe("sub-field slugs that are not bare identifiers", () => {
			// Sub-field slugs reach the emitter unvalidated. `SeedField.validation` is
			// `Record<string, unknown>`, `validateSeed` pattern-checks only top-level
			// field slugs, and the registry stringifies `validation` without reading
			// it, so a seed can declare any string here.
			const HOSTILE_SLUGS = ["first-name", "2fa", "a: any }[] | { evil", 'quote" and \\ backslash'];

			function fileFor(slug: string): string {
				return generateTypesFile([
					makeRepeaterCollection([{ slug, label: "Value", type: "string", required: true }]),
				]);
			}

			function syntaxErrorsOf(file: string): string[] {
				const parsed = tsc.createSourceFile(
					"emdash-env.d.ts",
					file,
					tsc.ScriptTarget.Latest,
					false,
				);
				const diagnostics = (parsed as unknown as { parseDiagnostics: readonly tsc.Diagnostic[] })
					.parseDiagnostics;
				return diagnostics.map(
					(d) => `TS${d.code}: ${tsc.flattenDiagnosticMessageText(d.messageText, " ")}`,
				);
			}

			function declaresAny(type: tsc.TypeNode): boolean {
				let seen = false;
				const visit = (node: tsc.Node): void => {
					if (node.kind === tsc.SyntaxKind.AnyKeyword) seen = true;
					else tsc.forEachChild(node, visit);
				};
				visit(type);
				return seen;
			}

			it.each(HOSTILE_SLUGS)("emits a parseable declaration file for %j", (slug) => {
				// One unparseable member costs every collection in the file its types.
				expect(syntaxErrorsOf(fileFor(slug))).toEqual([]);
			});

			it("does not let a slug restructure the emitted type", () => {
				// Emitted bare, this slug closes the row object early and turns one
				// repeater into a union of two unrelated types.
				const type = specsTypeOf(fileFor("a: any }[] | { evil"));

				expect(tsc.isUnionTypeNode(type)).toBe(false);
				expect(declaresAny(type)).toBe(false);
			});
		});

		describe("duplicate sub-field slugs", () => {
			// `FieldEditor` derives a sub-field slug from its label without checking
			// uniqueness, and `repeaterSubFieldSchema` carries no uniqueness
			// refinement, so two sub-fields labelled "Name" both arrive as `name`.
			const DUPLICATED: RepeaterSubField[] = [
				{ slug: "a", label: "A", type: "string", required: true },
				{ slug: "name", label: "Name", type: "string", required: true },
				{ slug: "b", label: "B", type: "string", required: true },
				{ slug: "name", label: "Name", type: "number", required: true },
			];

			// `generateRepeaterRowSchema` assigns `shape[subField.slug]` per sub-field,
			// so a duplicated slug holds its first position and its last schema.
			function rowSchemaKeys(): string[] {
				const shape = generateZodSchema(
					makeRepeaterCollection(DUPLICATED, { required: true }),
				).shape;
				const specs = shape.specs as unknown as {
					element: { shape: Record<string, unknown> };
				};
				return Object.keys(specs.element.shape);
			}

			it("declares a duplicated slug once", () => {
				// Declaring it twice is TS2300, which costs the whole file its types.
				const members = rowMembersOf(generateTypesFile([makeRepeaterCollection(DUPLICATED)]));

				expect(members.map((member) => member.name)).toEqual(["a", "name", "b"]);
			});

			it("keeps the last declaration of a duplicated slug", () => {
				const members = rowMembersOf(generateTypesFile([makeRepeaterCollection(DUPLICATED)]));

				expect(members.find((member) => member.name === "name")?.type).toBe("number");
			});

			it("declares the members the row schema accepts", () => {
				const members = rowMembersOf(
					generateTypesFile([makeRepeaterCollection(DUPLICATED, { required: true })]),
				);

				expect(members.map((member) => member.name)).toEqual(rowSchemaKeys());
			});
		});

		it("keeps a required repeater non-optional", () => {
			const ts = generateTypeScript(
				makeRepeaterCollection([{ slug: "name", label: "Name", type: "text", required: true }], {
					required: true,
				}),
			);

			expect(ts).toContain(`specs: { "name": string }[];`);
		});
	});
});
