/**
 * Custom Worker Entrypoint
 *
 * Re-exports PluginBridge for sandboxed marketplace plugin execution.
 */

import handler from "@astrojs/cloudflare/entrypoints/server";

export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";

export default handler;
