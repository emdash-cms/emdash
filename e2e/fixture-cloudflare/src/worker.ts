import handler from "@astrojs/cloudflare/entrypoints/server";
import {
	EmDashRoom,
	EmDashRoomSite,
	handleRoomUpgrade,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";
import { installRegistryAuthoritativeFixture } from "emdash/internal/testing/registry";

declare const __EMDASH_REGISTRY_FIXTURE__: unknown;

if (__EMDASH_REGISTRY_FIXTURE__ !== null) {
	installRegistryAuthoritativeFixture(__EMDASH_REGISTRY_FIXTURE__);
}

export { EmDashRoom, EmDashRoomSite, PluginBridge };

const fetch: typeof handler.fetch = (request, env, ctx) =>
	handleRoomUpgrade(request, env) ?? handler.fetch(request, env, ctx);

export default { ...handler, fetch };
