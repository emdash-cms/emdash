import { getViteConfig } from "astro/config";

const stubs: Record<string, string> = {
	"virtual:emdash/wait-until": "export const waitUntil = undefined;",
	"virtual:emdash/config": "export default {};",
	"virtual:emdash/media-providers":
		"export const mediaProviders = globalThis.__emdashTestMediaProviders ?? [];",
	"virtual:emdash/block-components": "export const pluginBlockComponents = {};",
};

export default getViteConfig({
	plugins: [
		{
			name: "emdash-virtual-stubs",
			resolveId(id: string) {
				return Object.hasOwn(stubs, id) ? "\0" + id : null;
			},
			load(id: string) {
				const key = id.startsWith("\0") ? id.slice(1) : id;
				return Object.hasOwn(stubs, key) ? stubs[key] : null;
			},
		},
	],
	test: { globals: true, include: ["tests/repro/**/*.render.test.ts"] },
});
