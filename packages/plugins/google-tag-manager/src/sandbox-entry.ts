import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

export default definePlugin({
	hooks: {
		"page:fragments": async (_event: unknown, ctx: PluginContext) => {
			const containerId = await ctx.kv.get<string>("settings:gtmContainerId");
			if (!containerId) return null;

			const dataLayerName = (await ctx.kv.get<string>("settings:gtmDataLayerName")) || "dataLayer";
			const gtmScriptUrl =
				(await ctx.kv.get<string>("settings:gtmScriptUrl")) ||
				"https://www.googletagmanager.com/gtm.js";
			const gtmNoScriptUrl =
				(await ctx.kv.get<string>("settings:gtmNoScriptUrl")) ||
				"https://www.googletagmanager.com/ns.html";

			return [
				{
					kind: "inline-script",
					placement: "head",
					code: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'${gtmScriptUrl}?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','${dataLayerName}','${containerId}');`,
				},
				{
					kind: "html",
					placement: "body:start",
					html: `<noscript><iframe src="${gtmNoScriptUrl}?id=${containerId}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`,
				},
			];
		},
	},

	routes: {
		admin: {
			handler: async (
				routeCtx: { input: unknown; request: { url: string } },
				ctx: PluginContext,
			) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					values?: Record<string, string>;
				};

				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsBlocks(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_gtm") {
					const values = interaction.values || {};
					await ctx.kv.set("settings:gtmContainerId", values.gtm_container_id || "");
					await ctx.kv.set("settings:gtmDataLayerName", values.gtm_data_layer_name || "dataLayer");
					await ctx.kv.set(
						"settings:gtmScriptUrl",
						values.gtm_script_url || "https://www.googletagmanager.com/gtm.js",
					);
					await ctx.kv.set(
						"settings:gtmNoScriptUrl",
						values.gtm_noscript_url || "https://www.googletagmanager.com/ns.html",
					);

					const response = await buildSettingsBlocks(ctx);
					return {
						...response,
						toast: { message: "GTM settings saved", type: "success" },
					};
				}

				return { blocks: [] };
			},
		},
	},
});

async function buildSettingsBlocks(ctx: PluginContext) {
	const containerId = (await ctx.kv.get<string>("settings:gtmContainerId")) || "";
	const dataLayerName = (await ctx.kv.get<string>("settings:gtmDataLayerName")) || "dataLayer";
	const gtmScriptUrl =
		(await ctx.kv.get<string>("settings:gtmScriptUrl")) ||
		"https://www.googletagmanager.com/gtm.js";
	const gtmNoScriptUrl =
		(await ctx.kv.get<string>("settings:gtmNoScriptUrl")) ||
		"https://www.googletagmanager.com/ns.html";

	return {
		blocks: [
			{ type: "header", text: "Google Tag Manager" },
			{
				type: "section",
				text: "Configure your Google Tag Manager container and advanced URLs.",
			},
			{ type: "divider" },
			{
				type: "form",
				block_id: "gtm_settings_form",
				fields: [
					{
						type: "text_input",
						action_id: "gtm_container_id",
						label: "Container ID",
						initial_value: containerId,
						placeholder: "GTM-XXXXXXX",
					},
					{
						type: "text_input",
						action_id: "gtm_data_layer_name",
						label: "Data Layer Name",
						initial_value: dataLayerName,
						placeholder: "dataLayer",
					},
					{
						type: "text_input",
						action_id: "gtm_script_url",
						label: "GTM Script URL (gtm.js)",
						initial_value: gtmScriptUrl,
						placeholder: "https://www.googletagmanager.com/gtm.js",
					},
					{
						type: "text_input",
						action_id: "gtm_noscript_url",
						label: "GTM NoScript URL (ns.html)",
						initial_value: gtmNoScriptUrl,
						placeholder: "https://www.googletagmanager.com/ns.html",
					},
				],
				submit: { label: "Save Settings", action_id: "save_gtm" },
			},
		],
	};
}
