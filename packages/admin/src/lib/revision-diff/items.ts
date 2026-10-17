import { longestIncreasingSubsequence } from "./align.js";
import type { DiffContext } from "./context.js";
import { diffField } from "./fields.js";
import { canonicalJsonWithoutKeys, isRecord, type UnknownRecord } from "./normalize.js";
import type {
	DiffBlockFieldDefinition,
	DiffBlockType,
	DiffFieldDescriptor,
	FieldDiff,
	ItemRow,
} from "./types.js";

const SYSTEM_KEYS = new Set(["_key", "_type", "_version"]);

/** Block and repeater field types whose descriptor kind differs from the type name. */
const KIND_OF_TYPE: Readonly<Record<string, string>> = { text: "richText", integer: "number" };

const UNSTRUCTURED: DiffFieldDescriptor = { kind: "json" };

export interface ItemSchema {
	/** Null for a repeater item, which the view numbers instead. */
	label: string | null;
	fields: readonly DiffBlockFieldDefinition[];
}

export type DescribeItem = (value: UnknownRecord) => ItemSchema;

export function describeBlock(blockTypes: readonly DiffBlockType[]): DescribeItem {
	const bySlug = new Map(blockTypes.map((blockType) => [blockType.slug, blockType]));
	return (value) => {
		const type = typeOf(value);
		const blockType = bySlug.get(type);
		const version = blockType?.versions.find((candidate) => candidate.version === value._version);
		return { label: blockType?.label || type, fields: version?.fields ?? [] };
	};
}

export function describeRepeaterItem(descriptor: DiffFieldDescriptor): DescribeItem {
	const subFields = descriptor.validation?.subFields;
	const fields = Array.isArray(subFields) ? subFields.filter(isFieldDefinition) : [];
	return () => ({ label: null, fields });
}

/** The descriptor the editor gives a block or repeater field, for diffing and drawing it. */
export function itemFieldDescriptor(definition: DiffBlockFieldDefinition): DiffFieldDescriptor {
	const options = definition.validation?.options;
	return {
		kind: KIND_OF_TYPE[definition.type] ?? definition.type,
		label: definition.label,
		required: definition.required,
		validation: definition.validation,
		...(Array.isArray(options)
			? {
					options: options
						.filter((option): option is string => typeof option === "string")
						.map((option) => ({ value: option, label: option })),
				}
			: {}),
	};
}

interface Item {
	/** The item's `_key` when no other item on its side shares it. */
	key: string | null;
	/** Equal for two items exactly when they hold the same type and values. */
	content: string;
	type: string;
	value: UnknownRecord;
}

/**
 * Rows of a blocks or repeater field in the new order, with each removed item right after the
 * item that preceded it. Items pair by unique `_key`, then by identical content, then by position
 * when at least one of the two has no key: repeaters save no keys at all. When neither side has
 * keys, any items still unpaired pair in order.
 */
export function diffItems(
	oldValue: readonly unknown[],
	newValue: readonly unknown[],
	path: string,
	describe: DescribeItem,
	context: DiffContext,
): ItemRow[] {
	const oldItems = toItems(oldValue);
	const newItems = toItems(newValue);
	const pairs = new Map<number, number>();
	pairByKey(oldItems, newItems, pairs);
	pairByContent(oldItems, newItems, pairs);
	const moved = movedItems(pairs);
	pairByPosition(oldItems, newItems, pairs, moved);
	pairKeylessRemainder(oldItems, newItems, pairs);

	const removedAfter = new Map<number, number[]>();
	const newIndexOf = new Map(Array.from(pairs, ([n, o]) => [o, n]));
	let anchor = -1;
	oldItems.forEach((_, o) => {
		const n = newIndexOf.get(o);
		if (n !== undefined) {
			if (!moved.has(n)) anchor = n;
			return;
		}
		const removed = removedAfter.get(anchor);
		if (removed) removed.push(o);
		else removedAfter.set(anchor, [o]);
	});

	const rows: ItemRow[] = [];
	const push = (
		status: "added" | "removed" | "paired",
		item: Item,
		previous: Item,
		position: number,
		isMoved: boolean,
	) => {
		const index = rows.length;
		const { label, fields, descriptors } = itemFields(
			previous,
			item,
			`${path}.${index}`,
			describe,
			context,
		);
		const changed = fields.some((field) => field.status !== "unchanged");
		rows.push({
			status: status === "paired" ? (changed ? "changed" : "unchanged") : status,
			targetId: `i-${path}-${index}`,
			type: item.type,
			label,
			position,
			moved: isMoved,
			fields,
			descriptors,
			value: item.value,
		});
	};
	const addRemoved = (anchorIndex: number) => {
		for (const o of removedAfter.get(anchorIndex) ?? []) {
			const item = oldItems[o];
			if (item) push("removed", item, item, o + 1, false);
		}
	};

	addRemoved(-1);
	newItems.forEach((item, n) => {
		const o = pairs.get(n);
		const previous = o === undefined ? undefined : oldItems[o];
		if (previous) push("paired", item, previous, n + 1, moved.has(n));
		else push("added", item, item, n + 1, false);
		addRemoved(n);
	});
	return rows;
}

function toItems(value: readonly unknown[]): Item[] {
	const keyCounts = new Map<string, number>();
	for (const raw of value) {
		const key = keyOf(raw);
		if (key) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
	}
	return value.map((raw) => {
		const record = isRecord(raw) ? raw : {};
		const key = keyOf(raw);
		return {
			key: key && keyCounts.get(key) === 1 ? key : null,
			content: canonicalJsonWithoutKeys(raw),
			type: typeOf(record),
			value: record,
		};
	});
}

function keyOf(raw: unknown): string | null {
	return isRecord(raw) && typeof raw._key === "string" && raw._key ? raw._key : null;
}

function typeOf(value: UnknownRecord): string {
	return typeof value._type === "string" ? value._type : "";
}

function isFieldDefinition(value: unknown): value is DiffBlockFieldDefinition {
	return (
		isRecord(value) &&
		typeof value.slug === "string" &&
		typeof value.type === "string" &&
		(value.label === undefined || typeof value.label === "string")
	);
}

function pairByKey(
	oldItems: readonly Item[],
	newItems: readonly Item[],
	pairs: Map<number, number>,
) {
	const oldByKey = new Map<string, number>();
	oldItems.forEach((item, o) => {
		if (item.key) oldByKey.set(item.key, o);
	});
	newItems.forEach((item, n) => {
		const o = item.key ? oldByKey.get(item.key) : undefined;
		if (o !== undefined && oldItems[o]?.type === item.type) pairs.set(n, o);
	});
}

/** Pairs equal values across reorders, using occurrence order when a value appears more than once. */
function pairByContent(
	oldItems: readonly Item[],
	newItems: readonly Item[],
	pairs: Map<number, number>,
) {
	const pairedOld = new Set(pairs.values());
	const oldByContent = new Map<string, number[]>();
	for (let o = oldItems.length - 1; o >= 0; o--) {
		if (pairedOld.has(o)) continue;
		const item = oldItems[o];
		if (!item) continue;
		const indexes = oldByContent.get(item.content);
		if (indexes) indexes.push(o);
		else oldByContent.set(item.content, [o]);
	}
	newItems.forEach((item, n) => {
		if (pairs.has(n)) return;
		const o = oldByContent.get(item.content)?.pop();
		if (o !== undefined) pairs.set(n, o);
	});
}

/** New indexes of paired items outside the longest run that kept its order. */
function movedItems(pairs: ReadonlyMap<number, number>): Set<number> {
	const newOrder = [...pairs.keys()].toSorted((a, b) => a - b);
	const kept = longestIncreasingSubsequence(newOrder.map((n) => pairs.get(n) ?? 0));
	return new Set(newOrder.filter((_, position) => !kept.has(position)));
}

/**
 * Between two items that kept their place, pairs the remaining old and new items of the same
 * type in order, as an edit in place. Two items with different keys stay apart.
 */
function pairByPosition(
	oldItems: readonly Item[],
	newItems: readonly Item[],
	pairs: Map<number, number>,
	moved: ReadonlySet<number>,
) {
	const newIndexOf = new Map(Array.from(pairs, ([n, o]) => [o, n]));
	const oldGaps = new Map<number, number[]>();
	let anchor = -1;
	oldItems.forEach((_, o) => {
		const n = newIndexOf.get(o);
		if (n !== undefined) {
			if (!moved.has(n)) anchor = n;
			return;
		}
		oldGaps.set(anchor, [...(oldGaps.get(anchor) ?? []), o]);
	});
	anchor = -1;
	const newGaps = new Map<number, number[]>();
	newItems.forEach((_, n) => {
		if (pairs.has(n)) {
			if (!moved.has(n)) anchor = n;
			return;
		}
		newGaps.set(anchor, [...(newGaps.get(anchor) ?? []), n]);
	});
	for (const [gap, newGap] of newGaps) {
		const oldGap = oldGaps.get(gap) ?? [];
		newGap.forEach((n, index) => {
			const o = oldGap[index];
			const oldItem = o === undefined ? undefined : oldItems[o];
			const newItem = newItems[n];
			if (o === undefined || !oldItem || !newItem || oldItem.type !== newItem.type) return;
			if (oldItem.key && newItem.key) return;
			pairs.set(n, o);
		});
	}
}

/** Compare unmatched keyless values in order when matching anchors straddle an edit. */
function pairKeylessRemainder(
	oldItems: readonly Item[],
	newItems: readonly Item[],
	pairs: Map<number, number>,
) {
	if (oldItems.some((item) => item.key) || newItems.some((item) => item.key)) return;
	const pairedOld = new Set(pairs.values());
	const oldLeft = oldItems.flatMap((_, o) => (pairedOld.has(o) ? [] : [o]));
	const newLeft = newItems.flatMap((_, n) => (pairs.has(n) ? [] : [n]));
	for (let index = 0; index < Math.min(oldLeft.length, newLeft.length); index++) {
		const o = oldLeft[index];
		const n = newLeft[index];
		if (o === undefined || n === undefined || oldItems[o]?.type !== newItems[n]?.type) continue;
		pairs.set(n, o);
	}
}

/**
 * The item's fields: those its schema defines, in order, then fields only the old schema defines
 * and stored values no schema defines, when they changed.
 */
function itemFields(
	previous: Item,
	item: Item,
	path: string,
	describe: DescribeItem,
	context: DiffContext,
): { label: string | null; fields: FieldDiff[]; descriptors: Record<string, DiffFieldDescriptor> } {
	const schema = describe(item.value);
	const fields: FieldDiff[] = [];
	const descriptors: Record<string, DiffFieldDescriptor> = {};
	const seen = new Set<string>();
	const add = (slug: string, descriptor: DiffFieldDescriptor, onlyChanged: boolean) => {
		if (seen.has(slug) || SYSTEM_KEYS.has(slug)) return;
		seen.add(slug);
		const diff = diffField(
			slug,
			descriptor,
			previous.value,
			item.value,
			context,
			`${path}.${slug}`,
		);
		if (onlyChanged && diff.status === "unchanged") return;
		fields.push(diff);
		descriptors[slug] = descriptor;
	};
	for (const definition of schema.fields) {
		add(definition.slug, itemFieldDescriptor(definition), false);
	}
	if (previous !== item) {
		for (const definition of describe(previous.value).fields) {
			add(definition.slug, itemFieldDescriptor(definition), true);
		}
	}
	for (const slug of new Set([...Object.keys(item.value), ...Object.keys(previous.value)])) {
		add(slug, UNSTRUCTURED, true);
	}
	return { label: schema.label, fields, descriptors };
}
