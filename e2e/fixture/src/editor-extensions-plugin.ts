import type { SandboxedPlugin } from "emdash/plugin";

const plugin: SandboxedPlugin = {
	routes: {
		"entry-health": {
			permission: "content:edit_own",
			handler: async (route) => {
				if (route.ui?.surface !== "content-editor-panel") return { blocks: [] };
				if (
					typeof route.input === "object" &&
					route.input !== null &&
					"type" in route.input &&
					route.input.type === "block_action" &&
					"action_id" in route.input &&
					(route.input.action_id === "translate-draft" ||
						route.input.action_id === "translate-slow") &&
					"draft" in route.input &&
					typeof route.input.draft === "object" &&
					route.input.draft !== null &&
					"fields" in route.input.draft &&
					typeof route.input.draft.fields === "object" &&
					route.input.draft.fields !== null
				) {
					if (route.input.action_id === "translate-slow") {
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
					const values = route.input.draft.fields;
					const title = "title" in values && typeof values.title === "string" ? values.title : "";
					const body = "body" in values && Array.isArray(values.body) ? values.body : [];
					return {
						blocks: [],
						patch: {
							type: "editor-draft-patch" as const,
							operations: [
								{ op: "set" as const, field: "title", value: `${title} translated` },
								{
									op: "set" as const,
									field: "body",
									value: body,
								},
							],
						},
					};
				}
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
							type: "actions",
							elements: [
								{ type: "button", action_id: "translate-draft", label: "Translate draft" },
								{ type: "button", action_id: "translate-slow", label: "Translate slowly" },
							],
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
