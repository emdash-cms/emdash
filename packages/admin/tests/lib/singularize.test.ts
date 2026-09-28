import { describe, expect, it } from "vitest";

import { singularize } from "../../src/lib/singularize";

describe("singularize", () => {
	it("handles the common English plural endings", () => {
		expect(singularize("Lessons")).toBe("Lesson");
		expect(singularize("Categories")).toBe("Category");
		expect(singularize("Classes")).toBe("Class");
		expect(singularize("Boxes")).toBe("Box");
		expect(singularize("Branches")).toBe("Branch");
		expect(singularize("Dishes")).toBe("Dish");
	});

	// A name that is already singular, or an irregular plural it cannot know
	// about, is left alone rather than mangled.
	it("leaves a name it cannot resolve alone", () => {
		expect(singularize("Chapter")).toBe("Chapter");
		expect(singularize("Press")).toBe("Press");
		expect(singularize("People")).toBe("People");
		expect(singularize("")).toBe("");
	});
});
