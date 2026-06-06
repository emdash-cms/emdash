/**
 * Cloudflare KV object-cache backend — RUNTIME ENTRY
 *
 * Backs EmDash's distributed object cache with a Workers KV namespace. KV is
 * globally replicated and built for high read volume, making it the right
 * place to absorb content/chrome reads that would otherwise hammer D1.
 *
 * This module imports `cloudflare:workers` to access the KV binding directly.
 * Do NOT import it at config time — use `kvCache()` from
 * `@emdash-cms/cloudflare` in `astro.config.mjs` instead.
 *
 * Wire it up:
 *
 * ```ts
 * import { kvCache } from "@emdash-cms/cloudflare";
 * emdash({ objectCache: kvCache({ binding: "CACHE" }) });
 * ```
 *
 * with a matching binding in `wrangler.jsonc`:
 *
 * ```jsonc
 * { "kv_namespaces": [{ "binding": "CACHE", "id": "..." }] }
 * ```
 */

import { env } from "cloudflare:workers";
import type { CreateObjectCacheBackendFn, ObjectCacheBackend } from "emdash";

/**
 * Workers KV enforces a 60-second floor on `expirationTtl`. Clamp shorter TTLs
 * up rather than letting `put` throw — epoch-based invalidation already
 * orphans stale keys immediately, so a slightly longer backstop TTL is benign.
 */
const KV_MIN_TTL_SECONDS = 60;

export const createObjectCache: CreateObjectCacheBackendFn = (config): ObjectCacheBackend => {
	const binding = typeof config.binding === "string" ? config.binding : "";
	if (!binding) {
		throw new Error("KV object-cache requires a `binding` name in its config.");
	}

	// `env` from cloudflare:workers has no index signature.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- KVNamespace binding accessed from untyped env object
	const kv = (env as Record<string, unknown>)[binding] as KVNamespace | undefined;
	if (!kv) {
		throw new Error(
			`KV binding "${binding}" not found. Add it to wrangler.jsonc:\n\n` +
				`{\n  "kv_namespaces": [{ "binding": "${binding}", "id": "<namespace-id>" }]\n}\n\n` +
				`and ensure you're running on Cloudflare Workers.`,
		);
	}

	return {
		async get(key: string): Promise<string | null> {
			return (await kv.get(key, "text")) ?? null;
		},
		async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
			if (ttlSeconds && ttlSeconds > 0) {
				await kv.put(key, value, {
					expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
				});
			} else {
				// No TTL: persistent key (used for epoch anchors).
				await kv.put(key, value);
			}
		},
		async delete(key: string): Promise<void> {
			await kv.delete(key);
		},
	};
};
