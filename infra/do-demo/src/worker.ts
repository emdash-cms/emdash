import handler from "@astrojs/cloudflare/entrypoints/server";

export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";
// The Durable Object that holds the CMS database. Registered as a
// new_sqlite_classes migration in wrangler.jsonc.
export { EmDashDB } from "@emdash-cms/cloudflare/db/do-sql";

export default handler;
