/**
 * Per-locale collation tailorings.
 *
 * A sort key is a string of fixed-width *collation elements* -- two characters
 * each, a primary bucket followed by a variant slot -- built so that an
 * ordinary binary comparison reproduces alphabetical order. SQLite and D1 have
 * no ICU collations, and `Intl.Collator` gives a comparator rather than a key
 * that can be stored and indexed, so the ordering has to be baked into the
 * bytes.
 *
 * The default element for a letter is the letter itself plus slot `0`. A
 * tailoring only lists the exceptions:
 *
 * - `"1"`..`"3"` place a variant immediately after its base letter, so Polish
 *   `ą` (`a1`) falls between `a` (`a0`) and `b` (`b0`).
 * - `"8"`/`"9"` place a digraph after every word beginning with its base
 *   letter, which is what makes Czech `chata` sort after `hzzz`.
 * - `"{"`..`"~"` are primaries above `z`, for the Nordic letters that
 *   alphabetize at the end of the alphabet.
 *
 * Locales absent from this table use the invariant order: accents fold to
 * their base letter. That is already correct for English, French, German
 * (DIN 5007-1), Dutch, Portuguese, Catalan, Basque and Indonesian.
 */

export interface Collation {
	/** Character sequence to collation element. Longest match wins. */
	readonly elements: ReadonlyMap<string, string>;
	/** Longest key in `elements`, in code points. */
	readonly maxSequenceLength: number;
}

/** Primaries above `z`, for letters that alphabetize after the Latin alphabet. */
const AFTER_Z = ["{", "|", "}", "~"] as const;

const TAILORINGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	// Swedish: ... x y z å ä ö. æ files as ä and ø as ö.
	sv: {
		å: `${AFTER_Z[0]}0`,
		ä: `${AFTER_Z[1]}0`,
		æ: `${AFTER_Z[1]}0`,
		ö: `${AFTER_Z[2]}0`,
		ø: `${AFTER_Z[2]}0`,
	},
	// Norwegian Bokmål: ... x y z æ ø å. ä files as æ and ö as ø.
	nb: {
		æ: `${AFTER_Z[0]}0`,
		ä: `${AFTER_Z[0]}0`,
		ø: `${AFTER_Z[1]}0`,
		ö: `${AFTER_Z[1]}0`,
		å: `${AFTER_Z[2]}0`,
	},
	// Czech: a b c č d ... h ch i ... r ř s š ... z ž.
	cs: {
		č: "c1",
		ch: "h9",
		ř: "r1",
		š: "s1",
		ž: "z1",
	},
	// Polish: a ą b c ć ... l ł m n ń o ó ... s ś ... z ź ż.
	pl: {
		ą: "a1",
		ć: "c1",
		ę: "e1",
		ł: "l1",
		ń: "n1",
		ó: "o1",
		ś: "s1",
		ź: "z1",
		ż: "z2",
	},
	// Turkish: ... c ç d e f g ğ h ı i j ... o ö p r s ş t u ü v y z.
	// Dotless ı and dotted i are distinct letters, so both are tailored --
	// the invariant fold would collapse them.
	tr: {
		ç: "c1",
		ğ: "g1",
		ı: "i0",
		i: "i1",
		ö: "o1",
		ş: "s1",
		ü: "u1",
	},
	// Azerbaijani shares Turkish's dotless-i rule and adds ə after e.
	az: {
		ç: "c1",
		ə: "e1",
		ğ: "g1",
		ı: "i0",
		i: "i1",
		ö: "o1",
		ş: "s1",
		ü: "u1",
	},
	// Spanish: ñ is a letter of its own, between n and o.
	es: {
		ñ: "n1",
	},
	// Serbian (Latin): a b c č ć d dž đ e ... l lj m n nj o ... s š ... z ž.
	"sr-latn": {
		č: "c1",
		ć: "c2",
		dž: "d1",
		đ: "d2",
		lj: "l1",
		nj: "n1",
		š: "s1",
		ž: "z1",
	},
	// Hungarian: accented vowels and the digraphs are each their own letter.
	// a á b c cs d dz dzs e é f g gy h i í j k l ly m n ny o ó ö ő p q r s sz
	// t ty u ú ü ű v w x y z zs.
	hu: {
		á: "a1",
		cs: "c9",
		dz: "d8",
		dzs: "d9",
		é: "e1",
		gy: "g9",
		í: "i1",
		ly: "l9",
		ny: "n9",
		ó: "o1",
		ö: "o2",
		ő: "o3",
		sz: "s9",
		ty: "t9",
		ú: "u1",
		ü: "u2",
		ű: "u3",
		zs: "z9",
	},
	// Ukrainian: а б в г ґ д е є ж з и і ї й ...
	// й carries a removable breve, so without an entry here it folds onto и.
	uk: {
		ґ: "г1",
		є: "е1",
		і: "и1",
		ї: "и2",
		й: "и3",
	},
};

function build(table: Readonly<Record<string, string>>): Collation {
	const elements = new Map(Object.entries(table));
	let maxSequenceLength = 1;
	for (const sequence of elements.keys()) {
		// oxlint-disable-next-line typescript/no-misused-spread -- sequences are matched by code point
		maxSequenceLength = Math.max(maxSequenceLength, [...sequence].length);
	}
	return { elements, maxSequenceLength };
}

const COLLATIONS: ReadonlyMap<string, Collation> = new Map(
	Object.entries(TAILORINGS).map(([tag, table]) => [tag, build(table)]),
);

/**
 * Find the tailoring for a BCP 47 tag, falling back through its parents.
 *
 * `es-419` and `es-ES` both resolve to the Spanish tailoring; `pt-BR`
 * resolves to none and gets the invariant order.
 */
export function resolveCollation(locale: string | undefined): Collation | undefined {
	if (!locale) return undefined;

	let tag = locale.toLowerCase();
	for (;;) {
		const collation = COLLATIONS.get(tag);
		if (collation) return collation;
		const cut = tag.lastIndexOf("-");
		if (cut === -1) return undefined;
		tag = tag.slice(0, cut);
	}
}

/** Locales with a collation tailoring, for tests and diagnostics. */
export const TAILORED_LOCALES: readonly string[] = Object.keys(TAILORINGS);
