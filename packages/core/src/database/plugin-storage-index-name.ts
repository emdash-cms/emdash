import { sha256 } from "@oslojs/crypto/sha2";
import { encodeHexLowerCase } from "@oslojs/encoding";

export function storageIndexHash(pluginId: string, collection: string, fields: string[]): string {
	const identity = JSON.stringify([pluginId, collection, fields]);
	return encodeHexLowerCase(sha256(new TextEncoder().encode(identity))).slice(0, 32);
}

/** Keep short legacy names, but never let PostgreSQL truncate a scope or field list. */
export function generateIndexName(
	pluginId: string,
	collection: string,
	fields: string[],
	options?: { unique?: boolean },
): string {
	const prefix = options?.unique ? "uidx" : "idx";
	const name = `${prefix}_plugin_${pluginId}_${collection}_${fields.join("_")}`;
	if (name.length <= 63) return name;
	return `${name.slice(0, 30)}_${storageIndexHash(pluginId, collection, fields)}`;
}
