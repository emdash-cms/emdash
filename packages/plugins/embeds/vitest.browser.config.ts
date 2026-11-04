import { getViteConfig } from "astro/config";

export default getViteConfig({
	test: {
		include: ["tests/**/*-browser.test.ts"],
		server: { deps: { inline: [/astro-embed/, /lite-youtube-embed/] } },
	},
});
