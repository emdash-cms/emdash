/**
 * Hidden property on a loaded entry's `data` naming its collection's
 * `titleField`. The loader reads the setting in the entry query, so
 * `getSeoMeta()` can fall back to that field without a query of its own.
 */
const ENTRY_TITLE_FIELD = Symbol.for("emdash:entryTitleField");

export function setEntryTitleField(data: Record<string, unknown>, titleField: string): void {
	Object.defineProperty(data, ENTRY_TITLE_FIELD, {
		value: titleField,
		enumerable: false,
		configurable: true,
	});
}

export function getEntryTitleField(data: object): string | undefined {
	const titleField: unknown = Reflect.get(data, ENTRY_TITLE_FIELD);
	return typeof titleField === "string" ? titleField : undefined;
}
