import { getViteConfig } from "astro/config";
import { configDefaults } from "vitest/config";

export default getViteConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: [...configDefaults.exclude, "tests/**/*-browser.test.ts"],
		server: { deps: { inline: [/astro-embed/, /lite-youtube-embed/] } },
	},
});
