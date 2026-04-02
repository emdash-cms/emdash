import type { RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

/** Aligns with documented route pattern: mutate endpoints should reject GET/HEAD. */
export function requirePost(ctx: RouteContext): void {
	if (ctx.request.method !== "POST") {
		throw new PluginRouteError("METHOD_NOT_ALLOWED", "Only POST is allowed", 405);
	}
}
