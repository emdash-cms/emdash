import handler from "@astrojs/cloudflare/entrypoints/server";
import { PluginBridge } from "@emdash-cms/cloudflare/worker";
import { installRegistryAuthoritativeFixture } from "emdash/testing/registry";

declare const __EMDASH_REGISTRY_FIXTURE__: unknown;

if (__EMDASH_REGISTRY_FIXTURE__ !== null) {
	installRegistryAuthoritativeFixture(__EMDASH_REGISTRY_FIXTURE__);
}

export { PluginBridge };

export default handler;
