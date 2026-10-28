import type { PluginContext } from "emdash";

/** Key in `ctx.kv` holding when the plugin created the AI Search instance. */
const CREATED_AT = "instance-created-at";

/**
 * How long after creating an instance AI Search may still answer "not found".
 * It usually serves the instance within a few seconds.
 */
const WARM_UP_MS = 60_000;

export async function markInstanceCreated(ctx: Pick<PluginContext, "kv">): Promise<void> {
	await ctx.kv.set(CREATED_AT, Date.now());
}

export async function isWarmingUp(ctx: Pick<PluginContext, "kv">): Promise<boolean> {
	const createdAt = await ctx.kv.get<number>(CREATED_AT);
	return createdAt !== null && Date.now() - createdAt < WARM_UP_MS;
}
