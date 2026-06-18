// Worker-level Cloudflare exports for the Flue build.
//
// Re-export @cloudflare/sandbox's `Sandbox` class so the `Sandbox` DO binding +
// container in wrangler.jsonc resolve to a real exported class. Flue re-exports
// these named values from the generated Worker entry. This is the documented
// "Connecting a remote sandbox" pattern:
// https://flueframework.com/docs/ecosystem/deploy/cloudflare/#connecting-a-remote-sandbox
export { Sandbox } from "@cloudflare/sandbox";
