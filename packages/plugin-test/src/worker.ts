export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";

export default {
	fetch() {
		return new Response("EmDash plugin test host");
	},
} satisfies ExportedHandler;
