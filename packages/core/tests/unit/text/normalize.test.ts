import { describe, it, expect } from "vitest";

import { foldLatinExpansions, foldMarks, normalizeText } from "../../../src/text/normalize.js";

const ZWNJ = "\u200C";
const SOFT_HYPHEN = "\u00AD";
const RTL_EMBEDDING = "\u202B";
const POP_DIRECTIONAL = "\u202C";

describe("normalizeText", () => {
	it("applies NFKC compatibility folding", () => {
		expect(normalizeText("ﬁnd")).toBe("find");
		expect(normalizeText("ＡＢＣ")).toBe("abc");
		expect(normalizeText("①")).toBe("1");
	});

	it("folds case without a locale", () => {
		expect(normalizeText("MiXeD Case")).toBe("mixed case");
	});

	it("keeps NFC and NFD spellings of the same word identical", () => {
		expect(normalizeText("café")).toBe(normalizeText("café"));
	});

	it("maps zero-width joiners to word separators", () => {
		expect(normalizeText(`می${ZWNJ}رود`)).toBe("مي رود");
	});

	it("removes soft hyphens and bidi controls", () => {
		expect(normalizeText(`co${SOFT_HYPHEN}operate`)).toBe("cooperate");
		expect(normalizeText(`${RTL_EMBEDDING}abc${POP_DIRECTIONAL}`)).toBe("abc");
	});

	it("removes Arabic tatweel", () => {
		expect(normalizeText("مــح")).toBe("مح");
	});

	it("collapses whitespace and trims", () => {
		expect(normalizeText("  a \t\n b  ")).toBe("a b");
	});

	describe("Arabic script", () => {
		it("unifies alef variants", () => {
			for (const variant of ["آ", "أ", "إ", "ٱ"]) {
				expect(normalizeText(variant)).toBe("ا");
			}
		});

		it("unifies Farsi yeh and keheh with their Arabic counterparts", () => {
			expect(normalizeText("ی")).toBe("ي");
			expect(normalizeText("ک")).toBe("ك");
		});

		it("folds alef maqsura to yeh", () => {
			expect(normalizeText("ى")).toBe("ي");
		});

		it("leaves ta marbuta alone -- that fold belongs to search only", () => {
			expect(normalizeText("ة")).toBe("ة");
		});

		it("leaves harakat in place for callers that need them", () => {
			expect(normalizeText("مُح")).toBe("مُح");
		});
	});

	describe("digit folding", () => {
		it("folds Arabic-Indic digits to ASCII", () => {
			expect(normalizeText("٢٨")).toBe("28");
		});

		it("folds extended Arabic-Indic (Farsi) digits to ASCII", () => {
			expect(normalizeText("۲۸")).toBe("28");
		});

		it("folds Devanagari and Thai digits to ASCII", () => {
			expect(normalizeText("२८")).toBe("28");
			expect(normalizeText("๒๘")).toBe("28");
		});
	});

	it("folds katakana to hiragana", () => {
		expect(normalizeText("トウキョウ")).toBe("とうきょう");
	});

	describe("Turkic case folding", () => {
		it("keeps dotless and dotted i distinct under a Turkish locale", () => {
			expect(normalizeText("I", { locale: "tr" })).toBe("ı");
			expect(normalizeText("İ", { locale: "tr" })).toBe("i");
		});

		it("collapses them under the invariant fold", () => {
			expect(normalizeText("I")).toBe("i");
			expect(foldMarks(normalizeText("İ"))).toBe("i");
		});
	});
});

describe("foldMarks", () => {
	it("removes Latin accents", () => {
		expect(foldMarks("áéîõü")).toBe("aeiou");
	});

	it("removes Arabic harakat", () => {
		expect(foldMarks("مُحَمَّد")).toBe("محمد");
	});

	it("removes Cyrillic combining marks", () => {
		expect(foldMarks("й")).toBe("и");
	});

	it("preserves Devanagari matras, which are letters and not accents", () => {
		const hindi = "हिन्दी";

		expect(foldMarks(hindi)).toBe(hindi);
	});

	it("preserves Thai vowel signs", () => {
		const thai = "สวัสดี";

		expect(foldMarks(thai)).toBe(thai);
	});

	it("preserves Hangul syllables through the NFD round trip", () => {
		expect(foldMarks("한국")).toBe("한국");
	});
});

describe("foldLatinExpansions", () => {
	it("expands letters that have no decomposition", () => {
		expect(foldLatinExpansions("ß")).toBe("ss");
		expect(foldLatinExpansions("æ")).toBe("ae");
		expect(foldLatinExpansions("œ")).toBe("oe");
		expect(foldLatinExpansions("ø")).toBe("o");
		expect(foldLatinExpansions("ł")).toBe("l");
		expect(foldLatinExpansions("ı")).toBe("i");
	});

	it("leaves other text untouched", () => {
		expect(foldLatinExpansions("plain text")).toBe("plain text");
	});
});
