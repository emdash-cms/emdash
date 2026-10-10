import { version } from "../package.json";
import type { AiSearchOptions } from "./options.js";

/** Declared metadata fields. Only these can be used in search filters and boosts. */
const CUSTOM_METADATA: AiSearchConfig["custom_metadata"] = [
	{ field_name: "source", data_type: "text" },
	{ field_name: "locale", data_type: "text" },
	{ field_name: "priority", data_type: "number" },
	{ field_name: "published_at", data_type: "datetime" },
];

/**
 * Returns the AI Search namespace binding, or null when the site is not running
 * on Cloudflare Workers or the binding is not configured.
 */
export async function getNamespace(options: AiSearchOptions): Promise<AiSearchNamespace | null> {
	try {
		const { env } = await import("./worker-env.js");
		const binding: unknown = Reflect.get(env, options.binding);
		return binding ? (binding as AiSearchNamespace) : null;
	} catch {
		return null;
	}
}

export async function getInstance(options: AiSearchOptions): Promise<AiSearchInstance | null> {
	const namespace = await getNamespace(options);
	return namespace ? namespace.get(options.instance) : null;
}

/** Returns the site's instance, creating it on first use. `created` is true when this call created it. */
export async function ensureInstance(
	namespace: AiSearchNamespace,
	options: AiSearchOptions,
): Promise<{ instance: AiSearchInstance; created: boolean }> {
	const instance = namespace.get(options.instance);
	try {
		await instance.info();
		return { instance, created: false };
	} catch {
		const created = await namespace.create({
			id: options.instance,
			index_method: { vector: true, keyword: true },
			custom_metadata: CUSTOM_METADATA,
			metadata: { created_from_emdash_plugin: { type: "native", version } },
		});
		return { instance: created, created: true };
	}
}
