import { describe, it, expect } from "vitest";

import { image } from "../../src/fields/image.js";

describe("image field", () => {
	it("should create field definition", () => {
		const field = image();

		expect(field.type).toBe("image");
		expect(field.schema).toBeDefined();
		expect(field.ui?.widget).toBe("image");
	});

	it("should accept valid image value", () => {
		const field = image();
		const valid = {
			id: "img-123",
			src: "https://example.com/image.jpg",
			alt: "Test image",
			width: 800,
			height: 600,
		};

		expect(() => field.schema.parse(valid)).not.toThrow();
	});

	it("should accept image without optional fields", () => {
		const field = image();
		const minimal = {
			id: "img-123",
		};

		expect(() => field.schema.parse(minimal)).not.toThrow();
	});

	it("should preserve cached media metadata", () => {
		const field = image();
		const value = {
			id: "img-123",
			provider: "local",
			filename: "image.webp",
			mimeType: "image/webp",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#d9d2c5",
			meta: { storageKey: "image.webp" },
		};

		expect(field.schema.parse(value)).toEqual(value);
	});

	it("should reject invalid image value", () => {
		const field = image();

		expect(() => field.schema.parse({ src: "https://example.com/image.jpg" })).toThrow();
		expect(() => field.schema.parse("not an object")).toThrow();
	});

	it("should support required option", () => {
		const required = image({ required: true });
		const optional = image({ required: false });

		// Required should reject undefined
		expect(() => required.schema.parse(undefined)).toThrow();

		// Optional should accept undefined
		expect(() => optional.schema.parse(undefined)).not.toThrow();
	});

	it("should store options", () => {
		const field = image({
			maxSize: 5 * 1024 * 1024, // 5MB
			allowedTypes: ["image/jpeg", "image/png"],
		});

		expect(field.options?.maxSize).toBe(5 * 1024 * 1024);
		expect(field.options?.allowedTypes).toEqual(["image/jpeg", "image/png"]);
	});
});
