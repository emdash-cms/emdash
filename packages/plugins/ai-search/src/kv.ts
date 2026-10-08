import type { PluginContext } from "emdash";

/**
 * Applies `change` to the value stored under `key`, retrying when another
 * writer got there first. `change` returns null to delete the value, or
 * undefined to leave it. Resolves to the stored result, or undefined when
 * `change` declined.
 */
export async function updateKv<T>(
	ctx: Pick<PluginContext, "kv">,
	key: string,
	change: (value: T | null) => T | null | undefined,
): Promise<T | null | undefined> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const current = await ctx.kv.getVersioned<T>(key);
		const next = change(current?.value ?? null);
		if (next === undefined) return undefined;
		if (next === null) {
			if (!current || (await ctx.kv.compareAndDelete(key, current.revision)).applied) return null;
			continue;
		}
		if ((await ctx.kv.compareAndSet(key, current?.revision ?? null, next)).applied) return next;
	}
	throw new Error(`[ai-search] ${key} changed too often to update`);
}
