import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^emdash$/,
				replacement: new URL("./tests/emdash-runtime.ts", import.meta.url).pathname,
			},
		],
	},
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
