import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [
		react({
			babel: {
				plugins: [["@lingui/babel-plugin-lingui-macro", { stripMessageField: false }]],
			},
		}),
		tailwindcss(),
		cloudflare(),
	],
});
