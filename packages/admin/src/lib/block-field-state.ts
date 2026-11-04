import type { BlockType } from "./api/schema.js";

export interface StoredBlockValue {
	_type: string;
	_version: number;
	_key: string;
	[key: string]: unknown;
}

function cloneValue<T>(value: T): T {
	return globalThis.structuredClone
		? globalThis.structuredClone(value)
		: JSON.parse(JSON.stringify(value));
}

export function createBlockValue(blockType: BlockType, key: string): StoredBlockValue {
	const version = blockType.versions.find(
		(candidate) => candidate.version === blockType.currentVersion,
	);
	const value: StoredBlockValue = {
		_type: blockType.slug,
		_version: blockType.currentVersion,
		_key: key,
	};
	for (const field of version?.fields ?? []) {
		if (field.defaultValue !== undefined) value[field.slug] = cloneValue(field.defaultValue);
	}
	return value;
}

export function duplicateBlockValue(block: StoredBlockValue, key: string): StoredBlockValue {
	return { ...cloneValue(block), _key: key };
}

export function moveBlockValue(
	blocks: readonly StoredBlockValue[],
	from: number,
	to: number,
): StoredBlockValue[] {
	if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) {
		return [...blocks];
	}
	const next = [...blocks];
	const [moved] = next.splice(from, 1);
	if (moved) next.splice(to, 0, moved);
	return next;
}

export function updateBlockFieldValue(
	blocks: readonly StoredBlockValue[],
	key: string,
	field: string,
	value: unknown,
): StoredBlockValue[] {
	return blocks.map((block) => (block._key === key ? { ...block, [field]: value } : block));
}

export function createBlockKey(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

export function isStoredBlockValue(value: unknown): value is StoredBlockValue {
	return Boolean(
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"_type" in value &&
		typeof value._type === "string" &&
		"_version" in value &&
		typeof value._version === "number" &&
		"_key" in value &&
		typeof value._key === "string",
	);
}
