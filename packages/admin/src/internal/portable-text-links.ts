import { equalJsonValues } from "../lib/json-values.js";

type MarkDef = { _key: string; _type: string; [key: string]: unknown };

/** Shares one definition across each contiguous run of equivalent links. */
export function normalizeAdjacentLinks(
	children: Array<{ marks?: string[] }>,
	markDefs: MarkDef[],
	storedKeys: ReadonlySet<string>,
): MarkDef[] {
	const definitions = new Map(markDefs.map((def) => [def._key, def]));
	const linkValues = new Map(
		markDefs
			.filter((def) => def._type === "link")
			.map(({ _key, blank = false, ...fields }) => [_key, { ...fields, blank }]),
	);
	let start = 0;
	while (start < children.length) {
		const first = children[start]!;
		const firstKey = first.marks?.find((key) => linkValues.has(key));
		if (!firstKey) {
			start++;
			continue;
		}
		let winner = firstKey;
		let end = start + 1;
		while (end < children.length) {
			const key = children[end]!.marks?.find((mark) => linkValues.has(mark));
			if (!key || !equalJsonValues(linkValues.get(firstKey), linkValues.get(key))) break;
			if (!storedKeys.has(winner) && storedKeys.has(key)) winner = key;
			end++;
		}
		// Rewrite only this run: a definition may also be used by a separate link.
		for (let index = start; index < end; index++) {
			const child = children[index]!;
			child.marks = child.marks?.map((key) =>
				definitions.get(key)?._type === "link" ? winner : key,
			);
		}
		start = end;
	}
	const usedKeys = new Set(children.flatMap((child) => child.marks ?? []));
	return markDefs.filter((def) => usedKeys.has(def._key));
}
