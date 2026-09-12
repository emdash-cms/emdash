import { describe, it, expect } from "vitest";

import { searchIndexText, searchNormalize, searchTokens } from "../../../src/text/search-key.js";

describe("searchNormalize", () => {
	it("folds case and accents so a query matches the indexed text", () => {
		expect(searchNormalize("Álvaro")).toBe("alvaro");
		expect(searchNormalize("CAFÉ")).toBe("cafe");
	});

	it("expands Latin letters with no decomposition", () => {
		expect(searchNormalize("Straße")).toBe("strasse");
	});

	it("folds case invariantly, so Turkish input matches either spelling", () => {
		expect(searchNormalize("İSTANBUL")).toBe("istanbul");
		expect(searchNormalize("ISTANBUL")).toBe("istanbul");
	});

	it("folds Greek final sigma, so a medial spelling still matches", () => {
		expect(searchNormalize("ΟΔΟΣ")).toBe(searchNormalize("οδοσ"));
	});

	describe("Arabic", () => {
		it("removes harakat", () => {
			expect(searchNormalize("مُحَمَّد")).toBe("محمد");
		});

		it("unifies alef variants so أحمد matches احمد", () => {
			expect(searchNormalize("أحمد")).toBe(searchNormalize("احمد"));
		});

		it("folds ta marbuta to heh for recall", () => {
			expect(searchNormalize("فاطمة")).toBe("فاطمه");
		});

		it("folds Arabic-Indic numerals to ASCII", () => {
			expect(searchNormalize("٢٨")).toBe("28");
		});
	});
});

describe("searchTokens", () => {
	it("splits on whitespace and punctuation", () => {
		expect(searchTokens("Hello, world!")).toEqual(["hello", "world"]);
	});

	it("keeps digits as tokens", () => {
		expect(searchTokens("iPhone 15")).toEqual(["iphone", "15"]);
	});

	it("preserves duplicates, which drive FTS ranking", () => {
		expect(searchTokens("the the")).toEqual(["the", "the"]);
	});

	it("returns an empty array when there is nothing to match", () => {
		expect(searchTokens("")).toEqual([]);
		expect(searchTokens("  !!  ")).toEqual([]);
	});

	describe("scripts without word boundaries", () => {
		it("indexes Han runs as overlapping bigrams", () => {
			expect(searchTokens("東京都")).toEqual(["東京", "京都"]);
		});

		it("emits a single token for a one-character run", () => {
			expect(searchTokens("都")).toEqual(["都"]);
		});

		it("bigrams Thai text rather than emitting one giant token", () => {
			const tokens = searchTokens("สวัสดี");

			expect(tokens.length).toBeGreaterThan(1);
			for (const token of tokens) {
				// oxlint-disable-next-line typescript/no-misused-spread -- counting code points
				expect([...token]).toHaveLength(2);
			}
		});

		it("folds katakana to hiragana so either spelling matches", () => {
			expect(searchTokens("トウキョウ")).toEqual(searchTokens("とうきょう"));
		});

		it("splits a word at the boundary between segmented and unsegmented runs", () => {
			expect(searchTokens("東京tower")).toEqual(["東京", "tower"]);
		});
	});
});

describe("searchIndexText", () => {
	it("renders tokens as the space-delimited string to store in FTS", () => {
		expect(searchIndexText("Hello, WORLD!")).toBe("hello world");
	});

	it("segments a query the same way it segmented the document", () => {
		const document = searchIndexText("東京都は日本の首都です");
		const query = searchIndexText("東京");

		expect(document.split(" ")).toContain(query);
	});

	it("lets an accented query reach unaccented indexed text", () => {
		expect(searchIndexText("Alvaro")).toBe(searchIndexText("Álvaro"));
	});
});
