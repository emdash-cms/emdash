const MAX_KEY_LENGTH = 1024;
const MAX_REVISION_LENGTH = 128;
const MAX_VALUE_BYTES = 1024 * 1024;

export function assertStorageKey(key: unknown, maxLength = MAX_KEY_LENGTH): asserts key is string {
	if (typeof key !== "string" || key.length === 0 || key.length > maxLength) {
		throw new TypeError(`Storage key must be a nonempty string of at most ${maxLength} characters`);
	}
}

export function assertStorageRevision(revision: unknown): asserts revision is string {
	if (
		typeof revision !== "string" ||
		revision.length === 0 ||
		revision.length > MAX_REVISION_LENGTH
	) {
		throw new TypeError("Storage revision must be a nonempty string of at most 128 characters");
	}
}

export function serializeConditionalValue(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new TypeError("Storage value must be JSON serializable");
	}
	if (new TextEncoder().encode(serialized).byteLength > MAX_VALUE_BYTES) {
		throw new TypeError("Conditional storage value must not exceed 1 MiB of JSON");
	}
	return serialized;
}
