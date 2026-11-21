import { sha256 } from "@oslojs/crypto/sha2";
import { encodeHexLowerCase } from "@oslojs/encoding";

export function storageIndexHash(pluginId: string, collection: string, fields: string[]): string {
	const identity = JSON.stringify([pluginId, collection, fields]);
	return encodeHexLowerCase(sha256(new TextEncoder().encode(identity))).slice(0, 32);
}

/** Preserve short lookup names; unique names must distinguish case-sensitive identities. */
export function generateIndexName(
	pluginId: string,
	collection: string,
	fields: string[],
	options?: { unique?: boolean },
): string {
	const prefix = options?.unique ? "uidx" : "idx";
	const name = `${prefix}_plugin_${pluginId}_${collection}_${fields.join("_")}`;
	const parts = [pluginId, collection, ...fields];
	if (
		name.length <= 63 &&
		(!options?.unique ||
			(name === name.toLowerCase() && parts.every((part) => !part.includes("_"))))
	) {
		return name;
	}
	// SQLite compares identifiers case-insensitively. The digest preserves case
	// and tuple boundaries; its suffix has no separators, unlike legacy names.
	return `${prefix}_plugin_${storageIndexHash(pluginId, collection, fields)}`;
}
