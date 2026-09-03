import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		environmentOptions: { jsdom: { url: "https://release.example.com" } },
		include: ["src/ui/**/*.test.{ts,tsx}"],
		setupFiles: ["./src/ui/test-setup.ts"],
	},
});
