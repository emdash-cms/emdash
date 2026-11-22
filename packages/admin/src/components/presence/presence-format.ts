import { prefersReducedMotion } from "./presence-motion.js";

const SPACES = /\s+/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Up to two letters: the first of the first word and of the last. */
export function initials(name: string): string {
	const words = name.trim().split(SPACES).filter(Boolean);
	const first = words[0];
	if (first === undefined) return "";
	const last = words.length > 1 ? words.at(-1) : undefined;
	// Not toLocaleUpperCase: the same initials in every admin language.
	return (initialOf(first) + (last ? initialOf(last) : "")).toUpperCase();
}

function initialOf(word: string): string {
	const characters = Array.from(GRAPHEMES.segment(word), ({ segment }) => segment);
	return characters.find((character) => LETTER_OR_DIGIT.test(character)) ?? characters[0] ?? "";
}

/**
 * Brings a person's field into view in the room's editor: their caret in rich text when it is
 * drawn, else the field.
 */
export function scrollToField(roomId: string, field: string, userId: string): void {
	const scope = `[data-co-editing-room="${CSS.escape(roomId)}"] [data-co-editing-field="${CSS.escape(field)}"]`;
	const caret = document.querySelector(
		`${scope} .emdash-remote-caret[data-user="${CSS.escape(userId)}"]`,
	);
	const target = caret ?? document.querySelector(scope);
	if (!target) return;
	const fits = target.getBoundingClientRect().height < window.innerHeight * 0.8;
	target.scrollIntoView({
		behavior: prefersReducedMotion() ? "instant" : "smooth",
		block: fits ? "center" : "start",
	});
}
