import type { LinguiConfig } from "@lingui/conf";

/**
 * Separate from the root lingui.config.ts (packages/admin's catalog): the
 * console ships as its own bundle under the labeler Worker, not through
 * @emdash-cms/admin, so it tracks its own locale rollout independently.
 */
const config: LinguiConfig = {
	sourceLocale: "en",
	locales: ["en"],
	catalogs: [
		{
			path: "<rootDir>/src/locales/{locale}/messages",
			include: ["<rootDir>/src/**/*.{ts,tsx}"],
		},
	],
	format: "po",
};

export default config;
