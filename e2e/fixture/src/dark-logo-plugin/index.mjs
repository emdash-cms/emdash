import { fileURLToPath } from "node:url";

import { definePlugin } from "emdash";

export function createPlugin() {
	return definePlugin({
		id: "dark-logo-test",
		version: "1.0.0",
		capabilities: [],
		admin: {
			portableTextBlocks: [
				{
					type: "brandLogo",
					label: "Brand logo",
					icon: "image",
					fields: [
						{ type: "media_picker", action_id: "logo", label: "Logo", dark_variant: true },
						{ type: "text_input", action_id: "alt", label: "Alt text" },
						{
							type: "repeater",
							action_id: "partners",
							label: "Partners",
							item_label: "Partner",
							fields: [
								{ type: "text_input", action_id: "name", label: "Name" },
								{ type: "media_picker", action_id: "mark", label: "Mark", dark_variant: true },
							],
						},
					],
				},
			],
		},
	});
}

export default createPlugin;

export function darkLogoPlugin() {
	return {
		id: "dark-logo-test",
		version: "1.0.0",
		entrypoint: fileURLToPath(import.meta.url),
		componentsEntry: fileURLToPath(new URL("./components.mjs", import.meta.url)),
		options: {},
	};
}
