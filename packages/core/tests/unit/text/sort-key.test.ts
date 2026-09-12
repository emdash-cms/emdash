import { describe, it, expect } from "vitest";

import { sortKey } from "../../../src/text/sort-key.js";

/**
 * Order a list the way the database would: compare the stored sort keys with
 * a binary collation, which is what SQLite and D1 do for TEXT.
 */
function alphabetize(values: readonly string[], locale?: string): string[] {
	return values.toSorted((a, b) => {
		const left = sortKey(a, { locale });
		const right = sortKey(b, { locale });
		if (left < right) return -1;
		if (left > right) return 1;
		return 0;
	});
}

describe("sortKey", () => {
	it("alphabetizes across case and accents", () => {
		expect(alphabetize(["Zoe", "Adam", "alice", "Álvaro"])).toEqual([
			"Adam",
			"alice",
			"Álvaro",
			"Zoe",
		]);
	});

	it("returns an empty key for input with no sortable characters", () => {
		expect(sortKey("")).toBe("");
		expect(sortKey("  ...  ")).toBe("");
	});

	it("produces colliding keys for text that folds together", () => {
		expect(sortKey("Álvaro")).toBe(sortKey("alvaro"));
		expect(sortKey("Straße")).toBe(sortKey("strasse"));
	});

	it("drops punctuation but keeps word boundaries", () => {
		expect(sortKey("O'Brien")).toBe(sortKey("OBrien"));
		expect(sortKey("de la Cruz")).not.toBe(sortKey("delacruz"));
	});

	it("orders separators before letters", () => {
		expect(alphabetize(["de la Cruz", "delacruz", "delta"])).toEqual([
			"de la Cruz",
			"delacruz",
			"delta",
		]);
	});

	it("caps key length at whole elements", () => {
		const key = sortKey("abcdefghij", { maxLength: 6 });

		expect(key).toBe("a0b0c0");
	});

	describe("numeric runs", () => {
		it("compares digit runs by value", () => {
			expect(alphabetize(["Chapter 10", "Chapter 2", "Chapter 1"])).toEqual([
				"Chapter 1",
				"Chapter 2",
				"Chapter 10",
			]);
		});

		it("ignores leading zeros", () => {
			expect(sortKey("007")).toBe(sortKey("7"));
		});

		it("falls back to lexicographic order when disabled", () => {
			const byKey = (value: string) => sortKey(value, { numeric: false });

			expect(byKey("Chapter 10") < byKey("Chapter 2")).toBe(true);
		});

		it("sorts numbers before letters and after separators", () => {
			expect(alphabetize(["beta", "2 alpha", "alpha"])).toEqual(["2 alpha", "alpha", "beta"]);
		});
	});

	describe("scripts other than Latin", () => {
		it("sorts non-Latin text after Latin text", () => {
			expect(alphabetize(["محمد", "Zoe"])).toEqual(["Zoe", "محمد"]);
		});

		it("alphabetizes Arabic names after normalization", () => {
			expect(alphabetize(["محمد", "أحمد", "علي"])).toEqual(["أحمد", "علي", "محمد"]);
		});

		it("ignores harakat when alphabetizing", () => {
			expect(sortKey("مُحَمَّد")).toBe(sortKey("محمد"));
		});

		it("treats Greek final and medial sigma as the same letter", () => {
			expect(sortKey("ΟΔΟΣ")).toBe(sortKey("οδοσ"));
		});

		it("alphabetizes Arabic-Indic numerals by value", () => {
			expect(alphabetize(["الفصل ١٠", "الفصل ٢"])).toEqual(["الفصل ٢", "الفصل ١٠"]);
		});
	});

	describe("locale tailorings", () => {
		it("uses the invariant order for German (DIN 5007-1)", () => {
			expect(alphabetize(["Zürich", "Ähre", "Osten"], "de")).toEqual(["Ähre", "Osten", "Zürich"]);
		});

		it("sorts Swedish å ä ö after z", () => {
			expect(alphabetize(["Öberg", "Zorn", "Ärlig", "Åkesson", "Adam"], "sv")).toEqual([
				"Adam",
				"Zorn",
				"Åkesson",
				"Ärlig",
				"Öberg",
			]);
		});

		it("sorts Norwegian æ ø å after z", () => {
			expect(alphabetize(["Ås", "Ødegård", "Ærlig", "Zahl", "Anders"], "nb")).toEqual([
				"Anders",
				"Zahl",
				"Ærlig",
				"Ødegård",
				"Ås",
			]);
		});

		it("sorts Czech ch as a letter between h and i", () => {
			expect(alphabetize(["Chata", "Hzzz", "Index", "Cukr", "Čaj"], "cs")).toEqual([
				"Cukr",
				"Čaj",
				"Hzzz",
				"Chata",
				"Index",
			]);
		});

		it("sorts Polish accented letters after their base", () => {
			expect(alphabetize(["Żaba", "Zaba", "Źle", "Łuk", "Lis", "Ósemka", "Osa"], "pl")).toEqual([
				"Lis",
				"Łuk",
				"Osa",
				"Ósemka",
				"Zaba",
				"Źle",
				"Żaba",
			]);
		});

		it("keeps Turkish dotless i before dotted i", () => {
			// Discriminating pair: the invariant fold collapses ı onto i and then
			// compares the second letter, which reverses these two.
			expect(alphabetize(["iade", "ışık"], "tr")).toEqual(["ışık", "iade"]);
			expect(alphabetize(["iade", "ışık"])).toEqual(["iade", "ışık"]);
		});

		it("files a Turkish accented i with i rather than with dotless ı", () => {
			// The tailoring renumbers i to slot 1, so any i-with-mark that falls
			// through to the default fold would land on ı's slot 0.
			expect(alphabetize(["ışık", "îmza", "iade"], "tr")).toEqual(["ışık", "iade", "îmza"]);
		});

		it("sorts Turkish ç after every c-initial word", () => {
			expect(alphabetize(["çam", "cuma"], "tr")).toEqual(["cuma", "çam"]);
			expect(alphabetize(["çam", "cuma"])).toEqual(["çam", "cuma"]);
		});

		it("sorts Hungarian digraphs as single letters", () => {
			expect(
				alphabetize(["Cukor", "Csaba", "Dzsungel", "Dzeta", "Domb", "Gyula", "Gabor"], "hu"),
			).toEqual(["Cukor", "Csaba", "Domb", "Dzeta", "Dzsungel", "Gabor", "Gyula"]);
		});

		it("sorts Serbian Latin digraphs and accented letters", () => {
			expect(
				alphabetize(
					["Čačak", "Ćuprija", "Cetinje", "Džemper", "Đorđe", "Dunav", "Ljubav", "Lav"],
					"sr-Latn",
				),
			).toEqual(["Cetinje", "Čačak", "Ćuprija", "Dunav", "Džemper", "Đorđe", "Lav", "Ljubav"]);
		});

		it("places Ukrainian й after ї, not alongside и", () => {
			// й carries a removable breve, so the invariant fold collapses it onto
			// и unless the tailoring claims it.
			expect(alphabetize(["йод", "їжак", "ігор", "ива"], "uk")).toEqual([
				"ива",
				"ігор",
				"їжак",
				"йод",
			]);
		});

		it("places Ukrainian ґ є і ї in alphabet order", () => {
			expect(
				alphabetize(
					["Ярема", "Іван", "Їжак", "Ігор", "Ганна", "Ґудзик", "Едуард", "Євген", "Зоя"],
					"uk",
				),
			).toEqual(["Ганна", "Ґудзик", "Едуард", "Євген", "Зоя", "Іван", "Ігор", "Їжак", "Ярема"]);
		});

		it("treats Spanish ñ as its own letter", () => {
			expect(alphabetize(["Ñandú", "Nube", "Ozono"], "es")).toEqual(["Nube", "Ñandú", "Ozono"]);
		});

		it("resolves regional tags to their base tailoring", () => {
			expect(sortKey("Ñandú", { locale: "es-419" })).toBe(sortKey("Ñandú", { locale: "es-ES" }));
			expect(sortKey("Ñandú", { locale: "es-419" })).not.toBe(sortKey("Ñandú"));
		});

		it("falls back to the invariant order for untailored locales", () => {
			expect(sortKey("Ação", { locale: "pt-BR" })).toBe(sortKey("Ação"));
		});
	});
});
