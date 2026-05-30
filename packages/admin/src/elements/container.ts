export const ContainerElement = {
	id: "container",
	name: "Container",
	icon: "container",
	category: "layout" as const,
	props: {
		background: { type: "color" as const, label: "Background Color", defaultValue: "#ffffff" },
		padding: { type: "string" as const, label: "Padding", defaultValue: "1rem" },
		maxWidth: { type: "string" as const, label: "Max Width", defaultValue: "1200px" },
		children: { type: "content" as const, label: "Container Content" },
	},
	defaults: {
		background: "#ffffff",
		padding: "1rem",
		maxWidth: "1200px",
	},
};
