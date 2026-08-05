export const MAX_ORDERED_LIST_START = 2_147_483_647;

export interface OrderedListMetadata {
	listId: string;
	listStart: number;
}

export interface OrderedListCounter extends OrderedListMetadata {
	count: number;
}

export function normalizeListId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 && normalized.length <= 128 ? normalized : undefined;
}

export function normalizeListStart(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= MAX_ORDERED_LIST_START
		? value
		: undefined;
}

export function deriveLegacyListId(seed: string): string {
	const readable = `legacy:${seed}`;
	if (readable.length <= 128) return readable;
	let hash = 2_166_136_261;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 16_777_619);
	}
	return `legacy:${seed.slice(0, 96)}:${(hash >>> 0).toString(36)}:${seed.length.toString(36)}`;
}

export function readOrderedListMetadata(
	attrs: Record<string, unknown> | undefined,
	fallbackId: string,
): OrderedListMetadata {
	return {
		listId: normalizeListId(attrs?.listId) ?? deriveLegacyListId(fallbackId),
		listStart: normalizeListStart(attrs?.listStart) ?? normalizeListStart(attrs?.start) ?? 1,
	};
}

export function takeOrderedListStart(
	counters: Map<string, OrderedListCounter>,
	metadata: OrderedListMetadata,
	directItemCount: number,
): number {
	const current = counters.get(metadata.listId);
	const listStart = current?.listStart ?? metadata.listStart;
	const count = current?.count ?? 0;
	const derived = listStart + count;
	const start = normalizeListStart(derived) ?? 1;
	counters.set(metadata.listId, {
		listId: metadata.listId,
		listStart,
		count: count + directItemCount,
	});
	return start;
}
