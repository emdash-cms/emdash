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
 * up rather than letting `put` throw — invalidation is epoch-comparison-based
 * (stale values are overwritten in place on read), so the TTL is only a
 * backstop for never-re-read keys and a slightly longer one is benign.
 */
const KV_MIN_TTL_SECONDS = 60;

/**
 * Default ceiling (ms) for a single KV operation. A KV read can stall without
 * ever resolving or rejecting — a cold cross-region read, or one queued behind
 * the Workers six-simultaneous-connection limit. Left unbounded, that hangs the
 * isolate. Racing against a timeout turns a stall into a rejection, which the
 * object-cache read path treats as a benign cache miss.
 */
const DEFAULT_KV_TIMEOUT_MS = 2000;

/**
 * Reject `promise` if it hasn't settled within `ms`. A `ms <= 0` disables the
 * timeout. The timer is always cleared so it can't keep the isolate alive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	if (!(ms > 0)) return promise;
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`KV ${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

	const timeout =
		typeof config.timeout === "number" && config.timeout >= 0
			? config.timeout
			: DEFAULT_KV_TIMEOUT_MS;

	return {
		async get(key: string): Promise<string | null> {
			return (await withTimeout(kv.get(key, "text"), timeout, "get")) ?? null;
		},
		async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
			const put =
				ttlSeconds && ttlSeconds > 0
					? kv.put(key, value, {
							expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
						})
					: // No TTL: persistent key (used for epoch anchors).
						kv.put(key, value);
			await withTimeout(put, timeout, "put");
		},
		async delete(key: string): Promise<void> {
			await withTimeout(kv.delete(key), timeout, "delete");
		},
	};
};
