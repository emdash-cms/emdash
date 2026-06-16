// Worker-level Cloudflare exports for the Flue build.
//
// @flue 0.11 no longer auto-wires the container Durable Object class into the
// generated Worker bundle (0.8 did, via the "class_name ends in Sandbox"
// heuristic). Re-export @cloudflare/sandbox's `Sandbox` class here so the
// `Sandbox` DO binding + container in wrangler.jsonc resolve to a real exported
// class. Flue re-exports these named values from the generated Worker entry.
export { Sandbox } from "@cloudflare/sandbox";
