import { describe, it, expect } from "vitest";

import { cn, slugify } from "../../src/lib/utils";

describe("slugify", () => {
	it("converts basic text to slug", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});

	it("handles unicode and diacritics", () => {
		expect(slugify("café résumé")).toBe("cafe-resume");
	});

	it("strips special characters", () => {
		expect(slugify("hello! @world# $")).toBe("hello-world");
	});

	it("collapses multiple hyphens", () => {
		expect(slugify("hello---world")).toBe("hello-world");
	});

	it("trims leading/trailing hyphens", () => {
		expect(slugify("-hello-world-")).toBe("hello-world");
	});

	it("handles underscores as separators", () => {
		expect(slugify("hello_world")).toBe("hello-world");
	});

	it("returns empty string for empty input", () => {
		expect(slugify("")).toBe("");
	});

	it("handles all special characters", () => {
		expect(slugify("!@#$%")).toBe("");
	});

	it("handles mixed case", () => {
		expect(slugify("HeLLo WoRLD")).toBe("hello-world");
	});

	it("handles multiple spaces", () => {
		expect(slugify("hello   world")).toBe("hello-world");
	});
});

describe("cn", () => {
	it("merges class names", () => {
		expect(cn("foo", "bar")).toBe("foo bar");
	});

	it("handles conditional classes", () => {
		const condition = false;
		expect(cn("foo", condition && "bar", "baz")).toBe("foo baz");
	});

	it("merges conflicting tailwind classes", () => {
		expect(cn("p-4", "p-2")).toBe("p-2");
	});

	it("handles undefined and null", () => {
		expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
	});
});
