import { describe, expect, it } from "vitest";

import { slugifyIdentifier } from "../../src/lib/slugify-identifier.js";

describe("slugifyIdentifier", () => {
	it("folds German umlauts and eszett into ASCII", () => {
		expect(slugifyIdentifier("Größe")).toBe("groesse");
		expect(slugifyIdentifier("Grüße")).toBe("gruesse");
		expect(slugifyIdentifier("Köln")).toBe("koeln");
	});

	it.each(["Größe", "Ärger mit Öl", "Grüße"])(
		"generates the same identifier for composed and decomposed %s",
		(label) => {
			expect(slugifyIdentifier(label.normalize("NFD"))).toBe(slugifyIdentifier(label));
		},
	);

	it("strips accents from Romance diacritics", () => {
		expect(slugifyIdentifier("Título")).toBe("titulo");
		expect(slugifyIdentifier("Ärger mit Öl")).toBe("aerger_mit_oel");
	});

	it("handles the requested ligature and special-letter table", () => {
		expect(slugifyIdentifier("æon")).toBe("aeon");
		expect(slugifyIdentifier("øre")).toBe("oere");
		expect(slugifyIdentifier("Łódź")).toBe("lodz");
	});

	it("returns an empty string for labels written entirely in non-Latin scripts", () => {
		expect(slugifyIdentifier("名前")).toBe("");
		expect(slugifyIdentifier("Имя")).toBe("");
	});

	it("returns an empty string when the only letters are digits or underscores", () => {
		expect(slugifyIdentifier("2024年")).toBe("");
	});

	it("keeps ordinary identifiers unchanged", () => {
		expect(slugifyIdentifier("My Field")).toBe("my_field");
		expect(slugifyIdentifier("field_1")).toBe("field_1");
		expect(slugifyIdentifier("  leading space  ")).toBe("leading_space");
	});

	it("truncates overly long results to the identifier limit", () => {
		const long = "a".repeat(100);
		expect(slugifyIdentifier(long)).toBe("a".repeat(63));
	});
});
