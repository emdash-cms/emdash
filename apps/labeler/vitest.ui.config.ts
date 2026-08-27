import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		react({
			babel: {
				plugins: [["@lingui/babel-plugin-lingui-macro", { stripMessageField: false }]],
			},
		}),
	],
	test: {
		environment: "jsdom",
		include: ["test/ui/**/*.test.{ts,tsx}"],
	},
});
