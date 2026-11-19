/** The palette people are told apart by, in revision history and co-editing presence. */
export type AuthorColor = "purple" | "teal" | "blue" | "orange" | "neutral";

const AUTHOR_PALETTE = ["purple", "teal", "blue", "orange"] as const;

function fnv1a(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Gives each author a palette colour from a hash of their id. Authors are placed in id order and
 * move to the next free colour on a collision, so two authors only share a colour once the
 * palette runs out.
 */
export function assignAuthorColors(
	authorIds: Iterable<string | null | undefined>,
): ReadonlyMap<string, AuthorColor> {
	const ids = [...new Set([...authorIds].filter((id): id is string => Boolean(id)))].toSorted();
	const taken = new Set<number>();
	const colors = new Map<string, AuthorColor>();
	for (const id of ids) {
		const start = fnv1a(id) % AUTHOR_PALETTE.length;
		let slot = start;
		for (let step = 1; taken.has(slot) && step < AUTHOR_PALETTE.length; step++) {
			slot = (start + step) % AUTHOR_PALETTE.length;
		}
		taken.add(slot);
		colors.set(id, AUTHOR_PALETTE[slot] ?? "neutral");
	}
	return colors;
}

export function authorColorOf(
	colors: ReadonlyMap<string, AuthorColor>,
	authorId: string | null | undefined,
): AuthorColor {
	return (authorId && colors.get(authorId)) || "neutral";
}
