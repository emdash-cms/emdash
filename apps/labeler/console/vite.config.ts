import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const consoleRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	root: consoleRoot,
	// Served as Workers static assets from the labeler Worker under /admin
	// (plan W9.3) — same-origin /admin/api/* calls need matching asset paths.
	base: "/admin/",
	plugins: [react(), tailwindcss()],
	build: {
		outDir: fileURLToPath(new URL("../dist/console", import.meta.url)),
		emptyOutDir: true,
	},
});
