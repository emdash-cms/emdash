import { z } from "astro/zod";
import { describe, it, expect } from "vitest";

import {
	text,
	textarea,
	number,
	boolean as booleanField,
	select,
	multiSelect,
	date,
	datetime,
	slug,
	image,
	file,
	reference,
	json,
	richText,
	portableText,
} from "../../../src/fields/index.js";

// Test regex patterns
const UPPERCASE_PATTERN_REGEX = /^[A-Z]+$/;
const SLUG_UPPERCASE_PATTERN_REGEX = /^[A-Z_]+$/;

describe("Field Types", () => {
	describe("text", () => {
		it("should create basic text field", () => {
			const field = text();
			expect(field.type).toBe("text");
			expect(field.schema).toBeDefined();
			expect(field.ui?.widget).toBe("text");
		});

		it("should validate required text", () => {
			const field = text({ required: true });
			expect(() => field.schema.parse("hello")).not.toThrow();
			expect(() => field.schema.parse(undefined)).toThrow();
		});

		it("should validate optional text", () => {
			const field = text({ required: false });
			expect(() => field.schema.parse("hello")).not.toThrow();
			expect(() => field.schema.parse(undefined)).not.toThrow();
		});

		it("should enforce minLength", () => {
			const field = text({ minLength: 5 });
			expect(() => field.schema.parse("hello")).not.toThrow();
			expect(() => field.schema.parse("hi")).toThrow();
		});

		it("should enforce maxLength", () => {
			const field = text({ maxLength: 10 });
			expect(() => field.schema.parse("hello")).not.toThrow();
			expect(() => field.schema.parse("hello world!")).toThrow();
		});

		it("should enforce pattern", () => {
			const field = text({ pattern: UPPERCASE_PATTERN_REGEX });
			expect(() => field.schema.parse("HELLO")).not.toThrow();
			expect(() => field.schema.parse("hello")).toThrow();
		});
	});

	describe("textarea", () => {
		it("should create textarea field", () => {
			const field = textarea();
			expect(field.type).toBe("textarea");
			expect(field.ui?.widget).toBe("textarea");
			expect(field.ui?.rows).toBe(6);
		});

		it("should accept custom rows", () => {
			const field = textarea({ rows: 10 });
			expect(field.ui?.rows).toBe(10);
		});

		it("should enforce length constraints", () => {
			const field = textarea({ minLength: 10, maxLength: 100 });
			expect(() => field.schema.parse("a".repeat(50))).not.toThrow();
			expect(() => field.schema.parse("short")).toThrow();
			expect(() => field.schema.parse("a".repeat(200))).toThrow();
		});
	});

	describe("number", () => {
		it("should create number field", () => {
			const field = number();
			expect(field.type).toBe("number");
			expect(field.ui?.widget).toBe("number");
		});

		it("should validate numbers", () => {
			const field = number({ required: true });
			expect(() => field.schema.parse(42)).not.toThrow();
			expect(() => field.schema.parse(3.14)).not.toThrow();
			expect(() => field.schema.parse("42")).toThrow();
		});

		it("should enforce integer constraint", () => {
			const field = number({ integer: true });
			expect(() => field.schema.parse(42)).not.toThrow();
			expect(() => field.schema.parse(3.14)).toThrow();
		});

		it("should enforce min/max", () => {
			const field = number({ min: 0, max: 100 });
			expect(() => field.schema.parse(50)).not.toThrow();
			expect(() => field.schema.parse(-1)).toThrow();
			expect(() => field.schema.parse(101)).toThrow();
		});
	});

	describe("boolean", () => {
		it("should create boolean field", () => {
			const field = booleanField();
			expect(field.type).toBe("boolean");
			expect(field.ui?.widget).toBe("boolean");
		});

		it("should validate booleans", () => {
			const field = booleanField();
			expect(() => field.schema.parse(true)).not.toThrow();
			expect(() => field.schema.parse(false)).not.toThrow();
			expect(() => field.schema.parse("true")).toThrow();
		});

		it("should apply default value", () => {
			const field = booleanField({ default: true });
			const result = field.schema.parse(undefined);
			expect(result).toBe(true);
		});
	});

	describe("select", () => {
		it("should create select field", () => {
			const field = select({ options: ["one", "two", "three"] as const });
			expect(field.type).toBe("select");
			expect(field.ui?.widget).toBe("select");
		});

		it("should validate enum values", () => {
			const field = select({
				options: ["red", "green", "blue"] as const,
				required: true,
			});
			expect(() => field.schema.parse("red")).not.toThrow();
			expect(() => field.schema.parse("yellow")).toThrow();
		});

		it("should apply default value", () => {
			const field = select({
				options: ["small", "medium", "large"] as const,
				default: "medium",
			});
			const result = field.schema.parse(undefined);
			expect(result).toBe("medium");
		});
	});

	describe("multiSelect", () => {
		it("should create multiSelect field", () => {
			const field = multiSelect({ options: ["a", "b", "c"] as const });
			expect(field.type).toBe("multiSelect");
			expect(field.ui?.widget).toBe("multiSelect");
		});

		it("should validate array of enum values", () => {
			const field = multiSelect({
				options: ["tag1", "tag2", "tag3"] as const,
				required: true,
			});
			expect(() => field.schema.parse(["tag1", "tag2"])).not.toThrow();
			expect(() => field.schema.parse(["tag1", "invalid"])).toThrow();
		});

		it("should enforce min/max selections", () => {
			const field = multiSelect({
				options: ["a", "b", "c", "d"] as const,
				min: 1,
				max: 3,
			});
			expect(() => field.schema.parse(["a", "b"])).not.toThrow();
			expect(() => field.schema.parse([])).toThrow();
			expect(() => field.schema.parse(["a", "b", "c", "d"])).toThrow();
		});
	});

	describe("datetime", () => {
		it("should create datetime field", () => {
			const field = datetime();
			expect(field.type).toBe("datetime");
			expect(field.ui?.widget).toBe("datetime");
		});

		it("should validate dates", () => {
			const field = datetime({ required: true });
			expect(() => field.schema.parse(new Date())).not.toThrow();
			expect(() => field.schema.parse("2024-01-01")).toThrow();
		});

		it("should enforce min/max dates", () => {
			const min = new Date("2024-01-01");
			const max = new Date("2024-12-31");
			const field = datetime({ min, max });

			expect(() => field.schema.parse(new Date("2024-06-15"))).not.toThrow();
			expect(() => field.schema.parse(new Date("2023-12-31"))).toThrow();
			expect(() => field.schema.parse(new Date("2025-01-01"))).toThrow();
		});
	});

	describe("date", () => {
		it("should create date field", () => {
			const field = date();
			expect(field.type).toBe("date");
			expect(field.ui?.widget).toBe("date");
		});

		it("should validate date-only strings", () => {
			const field = date({ required: true });
			expect(() => field.schema.parse("2026-02-26")).not.toThrow();
			expect(() => field.schema.parse("2026-02-26T09:30:00.000Z")).toThrow();
		});

		it("should preserve local calendar dates for Date min/max options", () => {
			const previousTimezone = process.env.TZ;
			process.env.TZ = "Asia/Tokyo";

			try {
				const field = date({
					required: true,
					min: new Date(2026, 1, 26),
					max: new Date(2026, 1, 28),
				});

				expect(field.ui?.min).toBe("2026-02-26");
				expect(field.ui?.max).toBe("2026-02-28");
				expect(() => field.schema.parse("2026-02-26")).not.toThrow();
				expect(() => field.schema.parse("2026-02-25")).toThrow("Date is too early");
			} finally {
				if (previousTimezone === undefined) {
					delete process.env.TZ;
				} else {
					process.env.TZ = previousTimezone;
				}
			}
		});
	});

	describe("slug", () => {
		it("should create slug field", () => {
			const field = slug();
			expect(field.type).toBe("slug");
			expect(field.ui?.widget).toBe("slug");
		});

		it("should validate slug format", () => {
			const field = slug({ required: true });
			expect(() => field.schema.parse("hello-world")).not.toThrow();
			expect(() => field.schema.parse("hello-world-123")).not.toThrow();
			expect(() => field.schema.parse("Hello World")).toThrow();
			expect(() => field.schema.parse("hello_world")).toThrow();
		});

		it("should accept custom pattern", () => {
			const field = slug({ pattern: SLUG_UPPERCASE_PATTERN_REGEX });
			expect(() => field.schema.parse("HELLO_WORLD")).not.toThrow();
			expect(() => field.schema.parse("hello-world")).toThrow();
		});
	});

	describe("image", () => {
		it("should create image field", () => {
			const field = image();
			expect(field.type).toBe("image");
			expect(field.ui?.widget).toBe("image");
		});

		it("should validate image value structure", () => {
			const field = image({ required: true });
			const validImage = {
				id: "img-123",
				src: "https://example.com/photo.jpg",
				alt: "A photo",
				width: 1920,
				height: 1080,
			};
			expect(() => field.schema.parse(validImage)).not.toThrow();
			// Missing the required `src` (and `id`) must be rejected.
			expect(() => field.schema.parse({ alt: "no src" })).toThrow();
			expect(() => field.schema.parse("not-an-object")).toThrow();
		});
	});

	describe("file", () => {
		it("should create file field", () => {
			const field = file();
			expect(field.type).toBe("file");
			expect(field.ui?.widget).toBe("file");
		});

		it("should validate file value structure", () => {
			const field = file({ required: true });
			const validFile = {
				id: "file-123",
				url: "https://example.com/doc.pdf",
				filename: "doc.pdf",
				mimeType: "application/pdf",
				size: 1024000,
			};
			expect(() => field.schema.parse(validFile)).not.toThrow();
			// Missing the required url/filename/mimeType must be rejected.
			expect(() => field.schema.parse({ id: "file-123" })).toThrow();
			expect(() => field.schema.parse("not-an-object")).toThrow();
		});
	});

	describe("reference", () => {
		it("should create reference field", () => {
			const field = reference({ to: "posts" });
			expect(field.type).toBe("reference");
			expect(field.ui?.widget).toBe("reference");
		});

		it("should validate string ID", () => {
			const field = reference({ to: "posts", required: true });
			expect(() => field.schema.parse("post-123")).not.toThrow();
			expect(() => field.schema.parse(123)).toThrow();
		});
	});

	describe("json", () => {
		it("should create json field", () => {
			const field = json();
			expect(field.type).toBe("json");
			expect(field.ui?.widget).toBe("json");
		});

		it("should accept any JSON data", () => {
			const field = json();
			expect(() => field.schema.parse({ foo: "bar" })).not.toThrow();
			expect(() => field.schema.parse([1, 2, 3])).not.toThrow();
			expect(() => field.schema.parse("string")).not.toThrow();
		});

		it("should validate with custom schema", () => {
			const customSchema = z.object({
				name: z.string(),
				age: z.number(),
			});

			const field = json({ schema: customSchema });
			expect(() => field.schema.parse({ name: "John", age: 30 })).not.toThrow();
			expect(() => field.schema.parse({ name: "John" })).toThrow();
		});
	});

	describe("richText", () => {
		it("should create richText field", () => {
			const field = richText();
			expect(field.type).toBe("richText");
			expect(field.ui?.widget).toBe("richText");
		});

		it("should validate string content", () => {
			const field = richText({ required: true });
			expect(() => field.schema.parse("# Heading\n\nParagraph")).not.toThrow();
			expect(() => field.schema.parse(123)).toThrow();
		});
	});

	describe("portableText", () => {
		it("should create portableText field", () => {
			const field = portableText();
			expect(field.type).toBe("portableText");
			expect(field.ui?.widget).toBe("portableText");
		});

		it("should validate array of blocks", () => {
			const field = portableText({ required: true });
			const blocks = [
				{
					_type: "block",
					_key: "key1",
					children: [{ _type: "span", text: "Hello" }],
				},
			];
			expect(() => field.schema.parse(blocks)).not.toThrow();
			// Must be an array of blocks, each with `_type` and `_key`.
			expect(() => field.schema.parse("not-an-array")).toThrow();
			expect(() => field.schema.parse([{ _type: "block" }])).toThrow();
		});
	});
});
