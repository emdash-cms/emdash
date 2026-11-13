import { prefersReducedMotion } from "./presence-motion.js";

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
