export const ColumnsElement = {
	id: "columns",
	name: "Columns",
	icon: "columns",
	category: "layout" as const,
	props: {
		columns: {
			type: "select" as const,
			label: "Number of Columns",
			defaultValue: "2",
			options: [
				{ label: "2 Columns", value: "2" },
				{ label: "3 Columns", value: "3" },
				{ label: "4 Columns", value: "4" },
			],
		},
		gap: {
			type: "string" as const,
			label: "Gap Between Columns",
			defaultValue: "1rem",
		},
		children: { type: "content" as const, label: "Column Content" },
	},
	defaults: {
		columns: "2",
		gap: "1rem",
	},
};
