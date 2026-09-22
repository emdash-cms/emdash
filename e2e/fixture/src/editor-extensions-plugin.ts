import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
	routes: {
		"entry-health": {
			permission: "content:edit_own",
			handler: async (route) => {
				if (route.ui?.surface !== "content-editor-panel") return { blocks: [] };
				return {
					blocks: [
						{
							type: "fields",
							fields: [
								{ label: "Collection", value: route.ui.entry.collection },
								{ label: "Saved entry", value: route.ui.entry.id },
								{ label: "Content locale", value: route.ui.entry.locale ?? "Default" },
								{ label: "Saved version", value: String(route.ui.entry.version) },
							],
						},
						{
							type: "banner",
							variant: "default",
							title: "Saved content only",
							description: "Unsaved editor changes are not sent to this plugin.",
						},
					],
				};
			},
		},
		"entry-recheck": {
			permission: "content:edit_own",
			handler: async () => ({
				refresh: true,
				toast: { type: "success", message: "Saved entry rechecked" },
			}),
		},
	},
};

export default plugin;
