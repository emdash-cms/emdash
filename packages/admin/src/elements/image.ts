export const ImageElement = {
	id: "image",
	name: "Image",
	icon: "image",
	category: "media" as const,
	props: {
		src: { type: "media" as const, label: "Image URL", required: true },
		alt: { type: "string" as const, label: "Alt Text", defaultValue: "" },
		width: { type: "string" as const, label: "Width", defaultValue: "100%" },
		height: { type: "string" as const, label: "Height", defaultValue: "auto" },
		alignment: {
			type: "select" as const,
			label: "Alignment",
			defaultValue: "left",
			options: [
				{ label: "Left", value: "left" },
				{ label: "Center", value: "center" },
				{ label: "Right", value: "right" },
			],
		},
	},
	defaults: {
		alt: "",
		width: "100%",
		height: "auto",
		alignment: "left",
	},
};
