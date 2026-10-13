import { getViteConfig } from "astro/config";

export default getViteConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
